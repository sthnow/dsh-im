import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failure = (code) => Object.assign(new Error(code), { code });
export function defaultHfcWorkerPath() {
  // esbuild emits lib/index.js; direct source imports live four levels below root.
  for (const relative of ['../assets/hfc/worker.py', '../../../../assets/hfc/worker.py']) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw failure('hfc-worker-asset-missing');
}

/** One process per turn. Any lifecycle/protocol failure poisons it permanently. */
export class HfcWorker {
  constructor({ python, workerPath, timeoutMs = 30_000, closeTimeoutMs = 2_000,
    maxInputBytes = 256 * 1024, maxOutputBytes = 8 * 1024 * 1024, maxPending = 8,
    spawnProcess = spawn } = {}) {
    if (typeof python !== 'string' || !python.trim()) throw failure('hfc-python-required');
    for (const n of [timeoutMs, closeTimeoutMs, maxInputBytes, maxOutputBytes, maxPending]) {
      if (!Number.isSafeInteger(n) || n < 1) throw failure('invalid-worker-budget');
    }
    Object.assign(this, { python, workerPath, timeoutMs, closeTimeoutMs, maxInputBytes, maxOutputBytes, maxPending, spawnProcess });
    this.pending = new Map(); this.closed = false; this.fault = null; this.buffer = Buffer.alloc(0);
  }
  _fail(code) {
    if (!this.fault) this.fault = failure(code);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.fault); }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
    this.child?.stdin?.destroy(); this.child?.kill();
  }
  async start() {
    if (this.closed) throw failure('worker-closed');
    if (this.fault) throw this.fault;
    if (this.startTask) return this.startTask;
    this.startTask = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.python, ['-I', '-S', '-B', this.workerPath ?? defaultHfcWorkerPath()], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          // No inherited bot/API credentials are needed by the pure renderer.
          env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), PYTHONIOENCODING: 'utf-8' },
        });
      } catch { this._fail('worker-unavailable'); reject(this.fault); return; }
      this.child = child;
      this.exitTask = new Promise((done) => { this.exitDone = done; });
      const startupTimer = setTimeout(() => { this._fail('worker-timeout'); reject(this.fault); }, this.timeoutMs);
      child.once('spawn', () => { clearTimeout(startupTimer); resolve(); });
      child.once('error', () => { clearTimeout(startupTimer); this._fail('worker-unavailable'); reject(this.fault); this.exitDone(); });
      child.once('close', () => { clearTimeout(startupTimer); reject(this.fault ?? failure('worker-unavailable')); });
      child.once('close', () => {
        if (!this.closed) this._fail('worker-unavailable');
        if (this.child === child) this.child = null;
        this.exitDone();
      });
      child.once('exit', () => { if (!this.closed) this._fail('worker-unavailable'); });
      child.stdin.on('error', () => this._fail('worker-unavailable'));
      child.stderr.resume(); // Never put event content or upstream stderr into diagnostics.
      child.stdout.on('error', () => this._fail('worker-unavailable'));
      child.stdout.on('end', () => { if (!this.closed) this._fail('worker-eof'); });
      child.stdout.on('data', (chunk) => this._onData(chunk));
    });
    return this.startTask;
  }
  _onData(chunk) {
    if (this.closed || this.fault) return;
    if (this.buffer.length + chunk.length > this.maxOutputBytes) { this._fail('worker-output-budget'); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      let response;
      try { response = JSON.parse(line.toString('utf8')); } catch { this._fail('worker-protocol-error'); return; }
      const p = this.pending.get(response?.id);
      if (!p || typeof response?.ok !== 'boolean') { this._fail('worker-protocol-error'); return; }
      if (response.ok && (p.op === 'reset' ? response.reset !== true : (
        typeof response.accepted !== 'boolean' || !response.card || typeof response.card !== 'object'
        || !['card', 'deferred_native', 'native', 'segmented'].includes(response.disposition)
        || !Array.isArray(response.segments)))) { this._fail('worker-protocol-error'); return; }
      this.pending.delete(response.id); clearTimeout(p.timer);
      if (!response.ok) {
        p.reject(failure('worker-event-rejected')); this._fail('worker-event-rejected'); return;
      }
      p.resolve(response);
    }
  }
  async request(op, extra = {}) {
    await this.start();
    if (this.closed || this.fault) throw this.fault ?? failure('worker-closed');
    if (this.pending.size >= this.maxPending) { this._fail('worker-pending-budget'); throw this.fault; }
    const id = randomUUID(); const line = JSON.stringify({ ...extra, id, op }) + '\n';
    if (Buffer.byteLength(line) > this.maxInputBytes) { this._fail('input_too_large'); throw this.fault; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail('worker-timeout'), this.timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      this.child.stdin.write(line, (error) => { if (error) this._fail('worker-unavailable'); });
    });
  }
  event(event) { return this.request('event', { event }); }
  reset() { return this.request('reset'); }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true; this._fail('worker-closed');
    this.closeTask = (async () => {
      if (!this.exitTask) return;
      let timer;
      const exited = await Promise.race([this.exitTask.then(() => true), new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
      })]);
      clearTimeout(timer);
      if (!exited) { this.child?.kill('SIGKILL'); throw failure('worker-close-timeout'); }
    })();
    return this.closeTask;
  }
}
