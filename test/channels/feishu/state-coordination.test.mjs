import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, link, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { StateStore } from '../../../src/channels/feishu/state-store.mjs';

const moduleUrl = new URL('../../../src/channels/feishu/state-store.mjs', import.meta.url).href;
const retired = { code: 'FEISHU_STATE_RETIRED' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-coordination-'));
  const handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(s => s.close())); await rm(dir, { recursive: true, force: true }); });
  return { dir, path: join(dir, 'state.json'), async load(path = join(dir, 'state.json')) { const s = new StateStore(path); handles.push(s); return s.load(); } };
}
async function childWrite(path, key) {
  const source = `import { StateStore } from ${JSON.stringify(moduleUrl)};
    const s = await new StateStore(${JSON.stringify(path)}).load();
    await s.setSession(${JSON.stringify(key)}, 'external'); await s.close();`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child watchdog timeout')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${output}`)); });
  });
}

test('physical aliases and duplicate module imports share a synchronously replaced mirror core', async t => {
  const f = await fixture(t);
  const a = await f.load();
  const alias = process.platform === 'win32' ? f.path.toUpperCase() : join(f.dir, '.', 'state.json');
  const b = await f.load(alias);
  const Duplicate = (await import(`${moduleUrl}?duplicate=coordination-test`)).StateStore;
  const c = await new Duplicate(f.path).load(); t.after(() => c.close());
  const original = { cardIds: ['old'] };
  const first = a.setMirror('key', original);
  assert.equal(b.mirrorEntries()[0][1], original, 'replacement is visible before await');
  await first;
  const replacement = { cardIds: ['new'] };
  const next = b.setMirror('key', replacement);
  assert.equal(c.mirrorEntries()[0][1], replacement);
  assert.notEqual(a.mirrorEntries()[0][1], original);
  await next;
  await Promise.all([a.setSession('a', 'one'), b.setSession('b', 'two'), c.markSeen('seen')]);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved.sessions, { a: 'one', b: 'two' });
  assert.deepEqual(saved.seenMessageIds, ['seen']);
});

test('stale cross-process writer conflicts and poisons reads, flush, no-op and reload without overwriting', async t => {
  const f = await fixture(t); const s = await f.load();
  await s.markSeen('already');
  await childWrite(f.path, 'outside');
  await assert.rejects(s.setSession('stale', 'must-not-save'), { code: 'FEISHU_STATE_CONFLICT' });
  assert.throws(() => s.snapshot(), { code: 'FEISHU_STATE_CONFLICT' });
  assert.throws(() => s.flush(), { code: 'FEISHU_STATE_CONFLICT' });
  await assert.rejects(s.markSeen('already'), { code: 'FEISHU_STATE_CONFLICT' });
  await assert.rejects(s.load(), { code: 'FEISHU_STATE_CONFLICT' });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).sessions, { outside: 'external' });
  await s.close();
  const fresh = await f.load();
  assert.equal(fresh.sessionFor('outside'), 'external');
});

test('retirement drains authorized snapshots and permanently fences raw, new, duplicate and no-op handles', async t => {
  const f = await fixture(t); const a = await f.load(); const b = await f.load();
  const authorized = a.setSession('queued', 'before-retirement');
  const drain = b.beginRetirement();
  await assert.rejects(a.markSeen('late'), retired);
  assert.throws(() => b.flush(), retired);
  await authorized; await drain; await b.retire();
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await assert.rejects(a.patchDeferred('absent', {}), retired);
  await assert.rejects(a.removeDeferred('absent'), retired);
  await assert.rejects(a.load(), retired);
  await a.close(); await b.close();
  await assert.rejects(f.load(), retired);
  const Duplicate = (await import(`${moduleUrl}?duplicate=retired`)).StateStore;
  const c = new Duplicate(f.path); t.after(() => c.close());
  await assert.rejects(c.load(), retired);
  assert.ok((await readFile(`${f.path}.coord.sqlite`)).length > 0, 'tombstone database survives unlink');
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('closing one handle drains its authorized writes without closing live siblings', async t => {
  const f = await fixture(t); const a = await f.load(); const b = await f.load();
  const writing = a.setSession('a', 'saved'); const closing = a.close();
  await assert.rejects(a.markSeen('closed'), { code: 'FEISHU_STATE_CLOSED' });
  await writing; await closing;
  assert.equal(b.sessionFor('a'), 'saved');
  await b.setSession('b', 'active'); await b.close();
  assert.deepEqual((await f.load()).snapshot().sessions, { a: 'saved', b: 'active' });
});

test('file symlinks and hardlinks are rejected; parent directory aliases coordinate', async t => {
  const f = await fixture(t); const a = await f.load();
  const hard = join(f.dir, 'hard.json'); await link(f.path, hard);
  assert.throws(() => new StateStore(hard), { code: 'FEISHU_STATE_UNSAFE_PATH' });
  assert.throws(() => a.flush(), { code: 'FEISHU_STATE_UNSAFE_PATH' });
  await rm(hard);
  const real = join(f.dir, 'real'); await mkdir(real);
  const alias = join(f.dir, 'alias');
  try { await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('parent alias creation not permitted'); return; } throw error; }
  const one = await f.load(join(real, 'state.json')); const two = await f.load(join(alias, 'state.json'));
  await one.setSession('via-real', 'shared');
  assert.equal(two.sessionFor('via-real'), 'shared');
});
