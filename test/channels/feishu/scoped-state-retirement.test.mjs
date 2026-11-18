import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionController } from '../../../plugin-src/host/channels/feishu/production.mjs';
import { LEGACY_FEISHU_SECRET_REF, PluginConfigStore } from '../../../src/channels/feishu/plugin-config-store.mjs';

const retired = { code: 'FEISHU_STATE_RETIRED' };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const bot = id => ({ id, appId: `cli_${id}`, secretRef: `SECRET_${id}`, ownerOpenIds: ['ou_owner'],
  botOpenId: `ou_${id}`, domain: 'feishu' });

// The controller, config store, workspace store, state store, Harness client,
// supervisor and production proxies are real. Only external runtime/HTTP and
// credential boundaries are substituted. All test files stay in the candidate.
async function fixture(t, { bots = [bot('alpha')], legacy = false, shared = false } = {}) {
  const dir = await mkdtemp(join(process.cwd(), '.scoped-state-test-'));
  const configPath = join(dir, 'config.json');
  if (legacy) await writeFile(configPath, JSON.stringify({ appId: 'cli_alpha', ownerOpenId: 'ou_owner', botOpenId: 'ou_alpha' }));
  else await writeFile(configPath, JSON.stringify({ version: 2, bots }));
  const loaded = await new PluginConfigStore(configPath).load();
  bots = loaded.list();
  const runtimes = new Map();
  const events = [];
  const controls = { onStop: null, onUnset: null, failCredential: false };
  class Runtime {
    constructor(options) { this.options = options; this.stops = 0; runtimes.set(options.botId, this); }
    status = { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true };
    async start() {}
    async stop() {
      this.stops++;
      events.push(`stop:${this.options.botId}`);
      await controls.onStop?.(this);
    }
  }
  const secrets = new Map(bots.map(b => [b.secretRef, 'test-secret']));
  const credentials = {
    async resolve(ref) { return { value: secrets.get(ref) }; },
    async set(ref, value) { secrets.set(ref, value); },
    async unset(ref) {
      events.push(`unset:${ref}`);
      await controls.onUnset?.(ref);
      if (controls.failCredential) throw new Error('credential boundary unavailable');
      secrets.delete(ref);
    },
  };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    const values = { 'host.describe': {}, 'llm.models': { groups: [], failures: [] },
      'workspace.list': { items: [] }, 'session.list': { items: [] } };
    assert.ok(Object.hasOwn(values, request.method), `unexpected HTTP RPC ${request.method}`);
    return { ok: true, json: async () => ({ type: 'server-response', rpcId: request.rpcId,
      result: { ok: true, value: values[request.method] } }) };
  });
  const disposers = [];
  const production = await createProductionController({ credentials,
    effect: setup => { disposers.push(setup()); }, logger: { error() {}, warn() {}, info() {} } }, {
    dataDir: dir, dshHome: dir, workspace: dir, harnessBaseUrl: 'http://127.0.0.1:1',
    ...(shared ? { statePath: join(dir, 'bots', 'beta', 'state.json') } : {}),
  }, { FeishuRuntime: Runtime, proxyEnv: {},
    verifyFeishuApp: async ({ appId }) => ({ openId: `ou_${appId.slice(4)}` }),
  });
  t.after(async () => {
    controls.onStop = null;
    await production.close();
    for (const dispose of disposers.reverse()) await dispose?.();
    await rm(dir, { recursive: true, force: true });
  });
  await production.controller.initialize();
  for (const b of bots) assert.ok(runtimes.has(b.id), `real controller started ${b.id}`);
  const pathFor = b => b.secretRef === LEGACY_FEISHU_SECRET_REF
    ? join(dir, ...(shared ? ['bots', 'beta'] : []), 'state.json') : join(dir, 'bots', b.id, 'state.json');
  return { dir, configPath, bots, production, controls, events, runtimes, secrets, pathFor };
}

test('real public deletion commits pending then fences before stop/credentials and rejects old scoped handles', async t => {
  const f = await fixture(t, { bots: [bot('alpha'), bot('beta')] });
  const state = f.runtimes.get('alpha').options.state;
  const other = f.runtimes.get('beta').options.state;
  await state.markSeen('before');
  await state.setSession('dm:ou_owner', 'session-alpha');
  await other.setSession('dm:ou_other', 'session-beta');
  f.controls.onStop = async runtime => {
    assert.equal((await json(f.configPath)).bots.find(b => b.id === 'alpha').deletionPending, true);
    await assert.rejects(runtime.options.state.markSeen('during-stop'), retired);
  };
  f.controls.onUnset = async () => { await assert.rejects(state.markSeen('during-unset'), retired); };
  await f.production.controller.deleteBot('alpha');
  f.controls.onStop = null;
  assert.deepEqual(f.events, ['stop:alpha', 'unset:SECRET_alpha']);
  await assert.rejects(readFile(f.pathFor(f.bots[0])), { code: 'ENOENT' });
  await assert.rejects(state.markSeen('after'), retired);
  await assert.rejects(state.flush(), retired);
  await assert.rejects(readFile(f.pathFor(f.bots[0])), { code: 'ENOENT' });
  assert.deepEqual((await json(f.configPath)).bots.map(b => b.id), ['beta']);
  await other.markSeen('still-active');
  assert.equal(other.sessionFor('dm:ou_other'), 'session-beta');
  assert.equal(f.runtimes.get('beta').stops, 0);
});

test('unknown deletion has no state/workspace side effects and cannot poison a later binding', async t => {
  const f = await fixture(t);
  const state = f.runtimes.get('alpha').options.state;
  const before = await readFile(join(f.dir, 'workspaces.json'), 'utf8');
  await assert.rejects(f.production.controller.deleteBot('unknown'), /Unknown Feishu bot/);
  assert.deepEqual(f.events, []);
  assert.equal(await readFile(join(f.dir, 'workspaces.json'), 'utf8'), before);
  await state.markSeen('still-active');
  const result = await f.production.controller.bindCredentials({ appId: 'cli_unknown', appSecret: 'new-secret' });
  assert.equal(result.bots.length, 2);
});

test('pending-save failure leaves scoped sessions/workspace and exclusive inbound owner usable', async t => {
  const f = await fixture(t);
  const { account } = await f.production.controller.describeDeliveryAccount('alpha');
  let accepted = 0;
  const options = { expectedFingerprint: account.fingerprint, onEvent: async () => { accepted++; return { accepted: true }; } };
  await f.production.controller.consumeInbound('alpha', options);
  const runtime = f.runtimes.get('alpha');
  const state = runtime.options.state;
  await state.setSession('dm:ou_owner', 'session-alpha');
  const workspaceBefore = await readFile(join(f.dir, 'workspaces.json'), 'utf8');
  const configBefore = await readFile(f.configPath, 'utf8');
  f.events.length = 0;
  await mkdir(`${f.configPath}.tmp`);
  await assert.rejects(f.production.controller.deleteBot('alpha'), error => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
  assert.deepEqual(f.events, []);
  assert.equal(await readFile(f.configPath, 'utf8'), configBefore);
  assert.equal(await readFile(join(f.dir, 'workspaces.json'), 'utf8'), workspaceBefore);
  assert.equal(state.sessionFor('dm:ou_owner'), 'session-alpha');
  await state.markSeen('pending-save-failed-but-active');
  await assert.rejects(f.production.controller.consumeInbound('alpha', options), { code: 'consumer-conflict' });
  assert.deepEqual(await runtime.options.acceptExternal({ event_id: 'event-1', app_id: 'cli_alpha',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'msg-1', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: 'hello' }), create_time: '1790787600000' } }), { accepted: true });
  assert.equal(accepted, 1);
  await rm(`${f.configPath}.tmp`, { recursive: true });
  await f.production.controller.deleteBot('alpha');
  await assert.rejects(state.markSeen('after-retry'), retired);
});

test('credential failure preserves durable pending/fence; retry completes without reopening old handles', async t => {
  const f = await fixture(t);
  const state = f.runtimes.get('alpha').options.state;
  await state.markSeen('before');
  f.controls.failCredential = true;
  await assert.rejects(f.production.controller.deleteBot('alpha'), /Unable to remove the Feishu credential/);
  assert.equal((await json(f.configPath)).bots[0].deletionPending, true);
  await assert.rejects(state.markSeen('after-failure'), retired);
  await readFile(f.pathFor(f.bots[0]));
  await f.production.controller.reconnectBot('alpha');
  assert.equal(f.runtimes.get('alpha').stops, 1);
  f.controls.failCredential = false;
  await f.production.controller.deleteBot('alpha');
  await assert.rejects(readFile(f.pathFor(f.bots[0])), { code: 'ENOENT' });
  await assert.rejects(state.markSeen('after-retry'), retired);
  assert.deepEqual((await json(f.configPath)).bots, []);
});

test('disconnect uses the same committed-pending fence instead of pre-clearing scoped sessions', async t => {
  const f = await fixture(t);
  const state = f.runtimes.get('alpha').options.state;
  await state.setSession('dm:ou_owner', 'session-alpha');
  await mkdir(`${f.configPath}.tmp`);
  await assert.rejects(f.production.controller.disconnect());
  assert.equal(state.sessionFor('dm:ou_owner'), 'session-alpha');
  await state.markSeen('still-active');
  await rm(`${f.configPath}.tmp`, { recursive: true });
  f.controls.onStop = async () => { await assert.rejects(state.markSeen('stopping'), retired); };
  await f.production.controller.disconnect();
  await assert.rejects(state.markSeen('deleted'), retired);
});

test('migrated legacy last-owner deletion remains compatible but does not revoke retained raw state', async t => {
  const f = await fixture(t, { legacy: true });
  const b = f.bots[0];
  assert.equal(b.secretRef, LEGACY_FEISHU_SECRET_REF);
  const state = f.runtimes.get(b.id).options.state;
  await state.markSeen('legacy-before');
  await f.production.controller.deleteBot(b.id);
  await assert.rejects(readFile(f.pathFor(b)), { code: 'ENOENT' });
  // Honest limitation: no per-bot legacy facade without changing the shared
  // physical-store lock identity. This old reference can recreate the file.
  await state.markSeen('legacy-old-reference-not-revoked');
  assert.ok((await json(f.pathFor(b))).seenMessageIds.includes('legacy-old-reference-not-revoked'));
});

test('shared legacy physical path is retained with sessions and the other real bot remains active', async t => {
  const alpha = { ...bot('alpha'), secretRef: LEGACY_FEISHU_SECRET_REF };
  const f = await fixture(t, { bots: [alpha, bot('beta')], shared: true });
  const legacy = f.runtimes.get('alpha').options.state;
  const other = f.runtimes.get('beta').options.state;
  await legacy.setSession('legacy-conversation', 'legacy-session');
  await other.setSession('other-conversation', 'other-session');
  // The v2 owner's read-only preflight refuses ambiguous ownership without
  // fencing either state or committing deletionPending.
  await assert.rejects(f.production.controller.deleteBot('beta'), /Cannot safely delete shared Feishu state/);
  assert.equal((await json(f.configPath)).bots.find(b => b.id === 'beta').deletionPending, undefined);
  await other.markSeen('preflight-failure-still-active');
  await f.production.controller.deleteBot('alpha');
  assert.equal((await json(f.pathFor(alpha))).sessions['legacy-conversation'], 'legacy-session');
  assert.equal(other.sessionFor('other-conversation'), 'other-session');
  await other.markSeen('other-survives');
  assert.equal(f.runtimes.get('beta').stops, 0);
  assert.deepEqual((await json(f.configPath)).bots.map(b => b.id), ['beta']);
});
