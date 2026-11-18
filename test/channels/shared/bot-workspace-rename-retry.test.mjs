import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BotWorkspaceStore } from '../../../src/channels/shared/bot-workspace-store.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'workspace-retry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.json');
  const original = JSON.stringify({ version: 1, workspaces: { bot: dir } });
  await fs.writeFile(path, original);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: dir }).load();
  return { path, original, store };
}

test('workspace: transient rename failures preserve destination and eventually succeed', { skip: process.platform !== 'win32' }, async t => {
  const { path, original, store } = await fixture(t);
  const rename = fs.rename;
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    calls++;
    assert.equal(await fs.readFile(path, 'utf8'), original);
    if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  await store.setAlias('bot', 'first');
  mock.mock.restore();
  assert.equal(calls, 3);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).aliases.bot, 'first');
});

test('workspace: exhausted retries preserve destination and queue recovers', { skip: process.platform !== 'win32' }, async t => {
  const { path, original, store } = await fixture(t);
  const cause = Object.assign(new Error('persistent denial'), { code: 'EACCES' });
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async () => { calls++; throw cause; });
  await assert.rejects(store.setAlias('bot', 'first'), error => error === cause || error.cause === cause);
  assert.equal(calls, 5);
  assert.equal(await fs.readFile(path, 'utf8'), original);
  mock.mock.restore();
  await store.setAlias('bot', 'second');
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).aliases.bot, 'second');
});

test('workspace: non-transient rename failure is not retried', async t => {
  const { path, original, store } = await fixture(t);
  const cause = Object.assign(new Error('bad rename'), { code: 'EXDEV' });
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async () => { calls++; throw cause; });
  await assert.rejects(store.setAlias('bot', 'first'), error => error === cause || error.cause === cause);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path, 'utf8'), original);
  mock.mock.restore();
  await store.setAlias('bot', 'second');
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).aliases.bot, 'second');
});
