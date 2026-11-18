import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionController } from '../../../plugin-src/host/channels/feishu/production.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const history = [
  { type: 'turn/start', seq: 100, data: { turn: 1 } },
  { type: 'user/message', seq: 101, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'question' }] } },
  { type: 'assistant/message', seq: 102, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'finished answer' }] } } },
  { type: 'turn/end', seq: 103, data: { turn: 1, reason: { kind: 'completed' } } },
];

test('production facade recovers orphan mirrors with stable isolated identities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-facade-orphan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let controllerOptions;
  class Controller { constructor(options) { controllerOptions = options; } async close() {} }
  class ConfigStore { async load() { return this; } }
  class Harness { stopManagedProcess() {} }
  class Runtime { constructor(options) { this.options = options; } }
  const workspaces = { async ensure() {}, incarnationFor() { return 1; }, has() { return true; }, accessPolicyFor() {}, decorateStatus(v) { return v; } };
  const production = await createProductionController({ credentials: {}, typertGateway: { invoke() {}, stream() {} }, logger: console },
    { dataDir: dir, dshHome: dir, workspace: dir }, {
      Controller, ConfigStore, HarnessClient: Harness, FeishuRuntime: Runtime, workspaces, groupHistory: {},
      inboundTtl: { stagingRetention() {}, trackStaged() {} }, proxyEnv: {}, lark: { registerApp() {} },
      createConnectionSupervisor: () => ({ start: () => ({ ready: Promise.resolve(), close: async () => {} }) }),
    });
  t.after(() => production.close());
  async function run(secretRef, botId, { replaceDuringLookup = false, replaceDuringPatch = false, missingClaim = false, answer = 'finished answer', blocks = false } = {}) {
    const runtime = await controllerOptions.createRuntime({ config: { id: botId, appId: `app-${botId}`, secretRef }, appSecret: 'test' });
    const state = runtime.options.state;
    const entry = { sessionId: 'session', turn: 1, chatId: 'ou_owner', targetId: 'owner', cardIds: ['original-card'], claimedAt: Date.now(), lastContent: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: '_running_' }] } }) };
    if (missingClaim) delete entry.claimedAt;
    if (blocks) entry.blocks = [];
    await state.setMirror('orphan', entry);
    const first = state.mirrorEntries()[0][1], second = state.mirrorEntries()[0][1];
    if (secretRef === 'V2_SECRET') {
      entry.cardIds[0] = 'caller-mutated';
      assert.throws(() => { first.cardIds[0] = 'snapshot-mutated'; }, TypeError);
      assert.equal(state.mirrorEntries()[0][1].cardIds[0], 'original-card');
    }
    const abort = new AbortController();
    t.after(() => abort.abort());
    let histories = 0, patches = 0, targets = 0, contents = [];
    const harness = {
      watchHarnessEvents: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
      rpc: async method => { assert.equal(method, 'session.history'); histories++; return { events: history.map(event => event.type === 'assistant/message' ? { ...event, data: { ...event.data, message: { content: [{ type: 'text', text: answer }] } } } : event), hasMore: false }; },
      ensureRunning: async () => true, sessionExists: async () => true,
    };
    const bridge = new FeishuHarnessBridge({ botId, state, harness, status: {}, channel: {}, signal: abort.signal,
      allowedSenderOpenIds: new Set(['ou_owner']), logger: { warn() {}, debug() {}, error() {} },
      sessionSyncTargetsFor: async () => {
        targets++;
        if (replaceDuringLookup && targets === replaceDuringLookup) {
          const old = state.mirrorEntries()[0][1];
          await state.setMirror('orphan', { ...old, cardIds: ['replacement-card'] });
          assert.notEqual(state.mirrorEntries()[0][1], old);
        }
        return [{ botId, targetId: 'owner', openId: 'ou_owner' }];
      },
      stepPushClock: { now: () => Date.now(), delay: async () => {} },
      client: { im: { v1: { message: {
        patch: async request => { patches++; contents.push(request.data.content); assert.equal(request.path.message_id, 'original-card'); if (replaceDuringPatch) await state.setMirror('orphan', { ...state.mirrorEntries()[0][1], cardIds: ['replacement-card'] }); return { code: 0 }; },
        create: async request => { contents.push(request.data.content); return { code: 0, data: { message_id: `new-${contents.length}` } }; },
      } } } },
    });
    await new Promise(resolve => setImmediate(resolve));
    await bridge.waitForIdle();
    if (answer.length > 10000) assert.ok(contents.length > 1, 'long answer spans multiple cards');
    if (patches) {
      const rendered = contents.flatMap(content => JSON.parse(content).body.elements.map(element => element.content ?? '')).join('');
      assert.equal(rendered.split(answer).length - 1, 1, 'recovered cards contain the complete final answer exactly once');
    }
    const result = { sameIdentity: first === second, targets, histories, patches, remaining: state.mirrorEntries().length };
    if (replaceDuringLookup || replaceDuringPatch) assert.deepEqual(state.mirrorEntries()[0][1].cardIds, ['replacement-card']);
    abort.abort();
    return result;
  }
  const legacy = await run('DSH_FEISHU_APP_SECRET', 'legacy');
  const v2 = await run('V2_SECRET', 'v2');
  assert.deepEqual(legacy, { sameIdentity: true, targets: 2, histories: 1, patches: 1, remaining: 0 });
  assert.deepEqual(v2, { sameIdentity: true, targets: 2, histories: 1, patches: 1, remaining: 0 });
  const noClaim = await run('V2_SECRET', 'missing-claim', { missingClaim: true });
  assert.deepEqual(noClaim, { sameIdentity: true, targets: 2, histories: 1, patches: 1, remaining: 0 });
  const race = await run('V2_SECRET', 'race', { replaceDuringLookup: 1 });
  assert.deepEqual(race, { sameIdentity: true, targets: 1, histories: 0, patches: 0, remaining: 1 });
  const lateRace = await run('V2_SECRET', 'late-race', { replaceDuringLookup: 2 });
  assert.deepEqual(lateRace, { sameIdentity: true, targets: 2, histories: 1, patches: 0, remaining: 1 });
  const patchRace = await run('V2_SECRET', 'patch-race', { replaceDuringPatch: true });
  assert.equal(patchRace.remaining, 1);
  const modern = await run('V2_SECRET', 'modern', { blocks: true });
  assert.equal(modern.remaining, 0);
  const long = await run('V2_SECRET', 'long', { answer: '长文本'.repeat(20000) });
  assert.equal(long.remaining, 0);
});
