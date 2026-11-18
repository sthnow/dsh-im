import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';

for (const [name, Store] of [['shared', ConversationStateStore], ['weixin', WeixinStateStore]]) {
  test(`${name}: transient rename failures retry without deleting destination`, { skip: process.platform !== 'win32' }, async t => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'state-retry-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.json');
    const store = await new Store(path).load();
    const original = await fs.readFile(path, 'utf8');
    const rename = fs.rename;
    let calls = 0;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
      calls++;
      assert.equal(await fs.readFile(path, 'utf8'), original);
      if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      return rename(from, to);
    });
    await store.setSession('user', 'session');
    mock.mock.restore();
    assert.equal(calls, 3);
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).sessions.user, 'session');
  });

  test(`${name}: exhausted rename failure propagates and queue recovers`, { skip: process.platform !== 'win32' }, async t => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'state-retry-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.json');
    const store = await new Store(path).load();
    const original = await fs.readFile(path, 'utf8');
    const cause = Object.assign(new Error('persistent denial'), { code: 'EPERM' });
    let calls = 0;
    const mock = t.mock.method(fs, 'rename', async () => { calls++; throw cause; });
    await assert.rejects(store.setSession('user', 'first'), error => error === cause || error.cause === cause);
    assert.equal(calls, 5);
    assert.equal(await fs.readFile(path, 'utf8'), original);
    mock.mock.restore();
    await store.setSession('user', 'second');
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).sessions.user, 'second');
  });

  test(`${name}: non-transient rename failure is not retried`, async t => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'state-retry-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.json');
    const store = await new Store(path).load();
    const original = await fs.readFile(path, 'utf8');
    const cause = Object.assign(new Error('bad rename'), { code: 'EXDEV' });
    let calls = 0;
    t.mock.method(fs, 'rename', async () => { calls++; throw cause; });
    await assert.rejects(store.setSession('user', 'session'), error => error === cause || error.cause === cause);
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(path, 'utf8'), original);
  });
}
