import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Symbol.for also coordinates duplicate ESM module instances within one isolate.
const registryKey = Symbol.for('@xmanrui/dsh-im/feishu-state-cores/v1');
const cores = globalThis[registryKey] ??= new Map();
export const stateError = (code, message) => Object.assign(new Error(message), { code });
export const retiredError = () => stateError('FEISHU_STATE_RETIRED', 'Feishu state binding is retired');

export function canonicalStatePath(path) {
  const absolute = resolve(path);
  let parent = dirname(absolute);
  const missing = [];
  for (;;) {
    try { parent = realpathSync.native(parent); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  const canonical = join(parent, ...missing, basename(absolute));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function rejectFileAlias(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw stateError('FEISHU_STATE_UNSAFE_PATH', 'Feishu state file aliases are unsupported');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function acquireCore(path, emptyState) {
  const key = canonicalStatePath(path);
  rejectFileAlias(key);
  let core = cores.get(key);
  if (!core) {
    core = { path: key, state: structuredClone(emptyState), queue: Promise.resolve(), refs: 0,
      loaded: false, loading: null, expectedHash: null, poison: null, retiring: false, retired: false };
    cores.set(key, core);
  }
  core.refs++;
  return core;
}

export async function releaseCore(core) {
  await core.loading?.catch(() => {});
  await core.queue;
  core.refs--;
  if (!core.refs && cores.get(core.path) === core) cores.delete(core.path);
}

// No await while holding an OS lock: another same-isolate reader cannot deadlock
// the writer. SQLite releases locks on process death; there is no PID/TTL takeover.
export function withStateGuard(core, action, { allowRetired = false } = {}) {
  mkdirSync(dirname(core.path), { recursive: true, mode: 0o700 });
  if (canonicalStatePath(core.path) !== core.path) {
    throw stateError('FEISHU_STATE_UNSAFE_PATH', 'Feishu state parent changed');
  }
  const sidecar = `${core.path}.coord.sqlite`;
  rejectFileAlias(core.path);
  rejectFileAlias(sidecar);
  let db;
  let transaction = false;
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (cause) {
      throw Object.assign(stateError('FEISHU_STATE_SQLITE_UNAVAILABLE', 'Feishu state requires node:sqlite'), { cause });
    }
    db = new DatabaseSync(sidecar);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    transaction = true;
    db.exec('CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY CHECK (id = 1), retired INTEGER NOT NULL)');
    const retired = db.prepare('SELECT retired FROM lifecycle WHERE id = 1').get()?.retired === 1;
    if (retired) core.retired = true;
    if (retired && !allowRetired) throw retiredError();
    return action(db, () => {
      db.exec('COMMIT'); transaction = false;
      // Tombstone is durable before unlink; if reacquisition fails, retry cleanup.
      db.exec('BEGIN EXCLUSIVE'); transaction = true;
    });
  } catch (error) {
    if (error?.errcode === 5 || error?.errcode === 6) {
      throw stateError('FEISHU_STATE_LOCKED', 'Feishu state is locked; retry the operation');
    }
    throw error;
  } finally {
    try { if (transaction) db.exec('ROLLBACK'); }
    finally { db?.close(); }
  }
}

export function readStateBytes(path) {
  try { return readFileSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export const stateHash = (bytes) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

export function assertCoreReadable(core) {
  if (core.retiring || core.retired) throw retiredError();
  if (core.poison) throw core.poison;
  if (!core.loaded) throw stateError('FEISHU_STATE_NOT_LOADED', 'Load Feishu state before use');
}

export function assertCoreUsable(core) {
  assertCoreReadable(core);
  withStateGuard(core, () => {});
}

export function loadCore(core, normalize) {
  if (core.retiring || core.retired) throw retiredError();
  if (core.poison) throw core.poison;
  if (core.loaded) { withStateGuard(core, () => {}); return; }
  withStateGuard(core, () => {
    const bytes = readStateBytes(core.path);
    const state = bytes === null ? core.state : normalize(JSON.parse(bytes.toString('utf8')));
    if (bytes === null) commitJson(core, JSON.stringify(state, null, 2) + '\n');
    else core.expectedHash = stateHash(bytes);
    core.state = state;
    core.loaded = true;
  });
}

function commitJson(core, snapshot) {
  const temporary = `${core.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, core.path);
    core.expectedHash = stateHash(Buffer.from(snapshot));
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function writeStateSnapshot(core, snapshot) {
  if (core.retired) throw retiredError();
  if (core.poison) throw core.poison;
  withStateGuard(core, () => {
    if (stateHash(readStateBytes(core.path)) !== core.expectedHash) {
      core.poison = stateError('FEISHU_STATE_CONFLICT', 'Feishu state changed in another writer; stale handle is unusable');
      throw core.poison;
    }
    commitJson(core, snapshot);
  });
}

export function beginCoreRetirement(core) {
  core.retiring = true;
  return core.queue;
}

export async function retireCore(core) {
  beginCoreRetirement(core);
  await core.loading?.catch(() => {});
  await core.queue;
  withStateGuard(core, (db, commit) => {
    db.exec('INSERT INTO lifecycle(id, retired) VALUES(1, 1) ON CONFLICT(id) DO UPDATE SET retired=1');
    commit();
    core.retired = true;
    try { unlinkSync(core.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, { allowRetired: true });
}
