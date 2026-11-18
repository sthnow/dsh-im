import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

// Offline only: real JS authority checks and pinned Python renderer; provider and
// Harness RPC transports are controlled boundaries, never live Feishu/DSH calls.
const python = process.env.DSH_HFC_TEST_PYTHON;
const real = { skip: !python, timeout: 30_000 };
const routeFor = (runtimeNamespace = randomUUID()) => ({ runtimeNamespace,
  botId: 'bot', sessionId: 'session-test', chatId: 'chat', senderId: 'user', turnId: '73' });
const receipt = { messageId: 'card', providerMessageIds: ['card'] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function node(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) { const found = node(child, predicate); if (found) return found; }
  return null;
}
function question(respond, multiSelect = false) {
  return { kind: 'question', interactionId: 'same-question', rpcId: 'rpc', sessionId: 'session-test',
    payload: { sessionId: 'session-test', questions: [{ id: 'q', question: 'Choose', multiSelect,
      options: [{ label: 'A' }, { label: 'B' }] }] }, respond };
}
function realAdapter(t, { route = routeFor(), signal, interactionTimeoutMs } = {}) {
  const worker = new HfcWorker({ python }); const cards = [], events = [], responses = [];
  const originalEvent = worker.event.bind(worker);
  worker.event = event => { events.push(structuredClone(event)); return originalEvent(event); };
  const adapter = new DshHfcAdapter({ worker, route, signal, interactionTimeoutMs,
    minRenderIntervalMs: 0, minPatchIntervalMs: 0, sink: {
      async create(card) { cards.push(card); return receipt; },
      async patch(card) { cards.push(card); return receipt; },
      async createInteraction(id, card) { cards.push(card); return { messageId: `rail:${id}` }; },
      async patchInteraction(id, messageId, card) { cards.push(card); return { messageId }; }, async native() { return receipt; },
    } });
  t.after(() => adapter.close());
  return { adapter, worker, route, cards, events, responses,
    async pending(multiSelect = false) {
      await adapter.start();
      await adapter.onInteraction(question(async response => { responses.push(response); return { accepted: true }; }, multiSelect));
    },
    button() { const found = node(cards.at(-1), n => n.value?.hfc_action === 'interaction.select');
      assert.ok(found, 'real Python choice button'); return { actor: route, messageId: `rail:${found.value.interaction_id}`, value: found.value }; },
    form() { const found = node(cards.at(-1), n => n.name?.startsWith('hfc_confirm_'));
      assert.ok(found, 'real Python native form');
      return { actor: route, messageId: 'rail:same-question:q:0', value: {}, name: found.name, formValue: { hfc_multi: ['A'], hfc_other: 'custom' } }; },
  };
}

test('adapter requires a UUID v4 runtime namespace, not a real/default profile name', () => {
  const worker = { async event() {} }, sink = { async create() {}, async patch() {}, async native() {} };
  for (const runtimeNamespace of [undefined, '', 'default', 'desktop', 'p', 'not-a-uuid',
    '00000000-0000-0000-0000-000000000000', '7b7d38a2-2459-11ee-be56-0242ac120002']) {
    assert.throws(() => new DshHfcAdapter({ worker, sink, route: { ...routeFor(), runtimeNamespace } }),
      /invalid-route|namespace/, String(runtimeNamespace));
  }
  const adapter = new DshHfcAdapter({ worker, sink, route: routeFor() });
  assert.equal(Object.hasOwn(adapter.route, 'profileId'), false);
});

test('real Python roundtrip preserves runtime UUID verbatim in wire profile_id, never default', real, async t => {
  const f = realAdapter(t); await f.pending(); const action = f.button();
  assert.equal(f.events[0].data.profile_id, f.route.runtimeNamespace);
  assert.equal(action.value.profile_id, f.route.runtimeNamespace);
  assert.notEqual(action.value.profile_id, 'default');
  assert.ok(f.events.every(event => event.data.profile_id === f.route.runtimeNamespace));
  assert.ok(f.events.every(event => !Object.hasOwn(event.data, 'runtimeNamespace')));
  assert.equal((await f.adapter.onAction(action)).accepted, true);
  assert.equal((await f.adapter.onAction(action)).accepted, false);
  assert.deepEqual(f.responses, [{ ok: true, value: { sessionId: 'session-test',
    answer: { answers: [{ id: 'q', selected: ['A'] }] } } }]);
});

test('real Python approval keeps namespace checks in front of the original approval respond closure', real, async t => {
  const f = realAdapter(t); await f.adapter.start();
  await f.adapter.onInteraction({ kind: 'approval', interactionId: 'approval', rpcId: 'rpc-a', sessionId: 'session-test',
    payload: { type: 'approval/requested', sessionId: 'session-test', approvalId: 'approval',
      toolName: 'read_file', callId: 'call', reason: 'fixture only' },
    toolCall: { callId: 'call', name: 'read_file', arguments: '{"path":"fixture.txt"}' },
    async respond(response) { f.responses.push(response); return { accepted: true }; },
  });
  const action = f.button();
  assert.equal(action.value.profile_id, f.route.runtimeNamespace);
  assert.equal((await f.adapter.onAction({ ...action, actor: { ...f.route, runtimeNamespace: randomUUID() } })).accepted, false);
  assert.equal((await f.adapter.onAction({ ...action, value: { ...action.value, token: 'forged' } })).accepted, false);
  assert.equal(f.responses.length, 0);
  assert.equal((await f.adapter.onAction(action)).accepted, true);
  assert.equal((await f.adapter.onAction(action)).accepted, false);
  assert.deepEqual(f.responses, [{ ok: true, value: { sessionId: 'session-test', approvalId: 'approval', outcome: 'allowed-once' } }]);
});

test('real adapter rejects all six forged actor fields plus wire namespace, token, choice and interaction', real, async t => {
  const f = realAdapter(t); await f.pending(); const action = f.button();
  for (const key of ['runtimeNamespace', 'botId', 'sessionId', 'chatId', 'senderId', 'turnId']) {
    const actor = { ...f.route, [key]: key === 'runtimeNamespace' ? randomUUID() : 'wrong' };
    assert.equal((await f.adapter.onAction({ ...action, actor })).accepted, false, key);
  }
  for (const patch of [{ profile_id: randomUUID() }, { profile_id: 'default' }, { token: 'wrong-token' },
    { interaction_id: 'wrong-interaction' }, { choice: 'unoffered' }, { hfc_action: 'wrong-action' }]) {
    assert.equal((await f.adapter.onAction({ ...action, value: { ...action.value, ...patch } })).accepted, false,
      Object.keys(patch)[0]);
  }
  assert.equal(f.responses.length, 0);
  assert.equal((await f.adapter.onAction(action)).accepted, true, 'forgeries must not consume the real authority');
  assert.equal(f.responses.length, 1);
});

test('A callback value cannot authorize B even with B actor; UUID is not a bearer credential', real, async t => {
  const a = realAdapter(t), b = realAdapter(t); await a.pending(); await b.pending();
  const old = a.button();
  assert.equal((await b.adapter.onAction({ ...old, actor: b.route })).accepted, false);
  assert.equal((await b.adapter.onAction({ ...b.button(), actor: a.route })).accepted, false);
  assert.equal(a.responses.length, 0); assert.equal(b.responses.length, 0);
  // Knowing B's UUID is insufficient without its registered callback token.
  assert.equal((await b.adapter.onAction({ ...old, actor: b.route,
    value: { ...old.value, profile_id: b.route.runtimeNamespace, token: 'unregistered-token' } })).accepted, false);
  assert.equal(b.responses.length, 0);
  assert.equal((await b.adapter.onAction(b.button())).accepted, true);
  assert.equal(a.responses.length, 0); assert.equal(b.responses.length, 1);
});

test('empty-value native forms stay owner/route/token bound across two real Python adapters', real, async t => {
  const a = realAdapter(t), b = realAdapter(t); await a.pending(true); await b.pending(true);
  const old = a.form(), current = b.form();
  assert.equal((await b.adapter.onAction({ ...old, actor: b.route })).accepted, false);
  for (const key of ['runtimeNamespace', 'botId', 'sessionId', 'chatId', 'senderId', 'turnId']) {
    assert.equal((await b.adapter.onAction({ ...current, actor: { ...b.route,
      [key]: key === 'runtimeNamespace' ? a.route.runtimeNamespace : 'wrong' } })).accepted, false, key);
  }
  assert.equal((await b.adapter.onAction({ ...current, name: 'hfc_confirm_unregistered-token' })).accepted, false);
  assert.equal(a.responses.length, 0); assert.equal(b.responses.length, 0);
  assert.equal((await b.adapter.onAction(current)).accepted, true);
  assert.equal((await b.adapter.onAction(current)).accepted, false);
  assert.deepEqual(b.responses[0].value.answer.answers, [{ id: 'q', selected: ['A'], custom: 'custom' }]);
  assert.equal(b.responses.length, 1); assert.equal(a.responses.length, 0);
});

for (const lifecycle of ['expired', 'close', 'abort', 'completed', 'resolved-elsewhere']) {
  test(`real Python stale callback is rejected after ${lifecycle}`, real, async t => {
    const controller = new AbortController();
    const f = realAdapter(t, { signal: controller.signal, ...(lifecycle === 'expired' ? { interactionTimeoutMs: 0 } : {}) });
    await f.pending(); const old = f.button();
    if (lifecycle === 'close') await f.adapter.close();
    if (lifecycle === 'abort') controller.abort();
    if (lifecycle === 'completed' || lifecycle === 'resolved-elsewhere') {
      await f.adapter.onInteractionResolved({ kind: 'question', sessionId: 'session-test', interactionId: 'same-question' });
      if (lifecycle === 'completed') await f.adapter.finish({ text: 'completed' });
    }
    assert.equal((await f.adapter.onAction(old)).accepted, false);
    assert.equal(f.responses.length, 0);
  });
}

function incoming(id) {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: {
    message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: 'chat', content: JSON.stringify({ text: 'test' }),
  } };
}
function realBridge(t, { runtimeNamespace = randomUUID(), multiSelect = false, responseGate, questions } = {}) {
  const writes = [], responses = [], adapters = [], actionEntries = [], ready = deferred(), release = deferred();
  const sessions = new Map([['p2p:user', 'session-test']]), seen = new Set(); let sequence = 0;
  const emit = async request => { const id = `message-${++sequence}`;
    if (request.data.msg_type === 'interactive') writes.push({ id, card: JSON.parse(request.data.content) });
    return { code: 0, data: { message_id: id } }; };
  const bridge = new FeishuHarnessBridge({ hfcRuntimeNamespace: runtimeNamespace, botId: 'bot',
    client: { im: { v1: { message: { create: emit, reply: emit, patch: async request => {
      const card = JSON.parse(request.data.content), previous = writes.find(w => w.id === request.path.message_id);
      assert.ok(previous, 'PATCH requires confirmed SDK message identity');
      assert.equal(card.schema ?? '1.0', previous.card.schema ?? '1.0', 'SDK mock keeps schema per message stable');
      writes.push({ id: request.path.message_id, card }); return { code: 0 }; },
    } } } }, channel: { async stream() { assert.fail('no native fallback in namespace security fixture'); } },
    state: { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: key => sessions.get(key),
      setSession: async (key, id) => sessions.set(key, id), clearSession: async key => sessions.delete(key) },
    harness: { async sessionExists() { return true; }, async createSession() { assert.fail('existing session only'); },
      async ask(_id, _text, options) {
        await options.onUpdate({ type: 'turn-start', turn: 73 });
        const interaction = question(async response => {
          responses.push(response); if (responseGate) await responseGate.promise;
          return { accepted: !responseGate };
        }, multiSelect);
        if (questions) interaction.payload.questions = questions;
        await options.onInteraction(interaction);
        ready.resolve(options); await release.promise;
        // Explicit external resolution clears pending authority without invoking respond.
        await options.onInteractionResolved({ kind: 'question', sessionId: 'session-test', interactionId: 'same-question' });
        return 'done';
      } }, allowedSenderOpenIds: new Set(['user', 'other']), status: {},
    stepPush: true, stepPushMode: 'hermes_card',
    hfcPresentation: { backend: 'hfc', testSessionIds: ['session-test'], python },
    logger: { warn() {}, info() {}, error() {} },
    hfcAdapterFactory: config => {
      const adapter = new DshHfcAdapter({ ...config, worker: new HfcWorker({ python }), minPatchIntervalMs: 0 });
      const original = adapter.onAction.bind(adapter);
      adapter.onAction = action => { actionEntries.push(action); return original(action); };
      adapters.push(adapter); return adapter;
    },
  });
  let running;
  t.after(async () => { responseGate?.resolve(); release.resolve(); await running;
    await Promise.all(adapters.map(adapter => adapter.close())); });
  return { bridge, writes, responses, sessions, adapters, actionEntries, release,
    async start(id = 'incoming') { running = (async () => { await bridge.accept(incoming(id)); await bridge.waitForIdle(); })();
      await Promise.race([ready.promise, running.then(() => assert.fail('Bridge ended before presenting the pending interaction'))]);
      return this; },
    async done() { release.resolve(); await running; },
    value() { const found = node(writes.at(-1)?.card, n => n.value?.hfc_action === 'interaction.select');
      assert.ok(found, 'Bridge uses real Python button'); return found.value; },
    form() { const found = node(writes.at(-1)?.card, n => n.name?.startsWith('hfc_confirm_'));
      assert.ok(found, 'Bridge uses real Python form'); return { value: {}, name: found.name, form_value: { hfc_multi: ['A'] } }; },
    callback(action, { messageId = writes.findLast(w => !w.card.schema)?.id, chatId = 'chat', senderId = 'user' } = {}) {
      return bridge.onCardAction({ operator: { open_id: senderId },
        context: { open_message_id: messageId, open_chat_id: chatId }, action });
    },
  };
}

test('real Bridge + Python rejects A values through B, old/unknown message map, chat and sender', real, async t => {
  const a = realBridge(t), b = realBridge(t); await a.start('in-A'); await b.start('in-B');
  const old = a.value(), value = b.value();
  assert.notEqual(old.profile_id, value.profile_id);
  await b.callback({ value: old }); // Provider ID deliberately collides: B still cannot accept A's value.
  await b.callback({ value }, { messageId: b.writes[0].id }); // Same-owner main card is not the rail.
  await b.callback({ value }, { messageId: b.writes[0].id, chatId: 'chat' });
  await b.callback({ value }, { messageId: 'pre-runtime-old-message' });
  await b.callback({ value }, { chatId: 'wrong-chat' });
  await b.callback({ value }, { senderId: 'other' });
  assert.equal(a.responses.length, 0); assert.equal(b.responses.length, 0);
  await b.callback({ value }); await b.callback({ value });
  assert.equal(b.responses.length, 1); assert.equal(a.responses.length, 0);
  await b.done(); await b.callback({ value });
  assert.equal(b.responses.length, 1); assert.equal(b.adapters[0].closed, true);
});

test('real Bridge empty-value form cannot cross owners and loses authority on session rebinding', real, async t => {
  const a = realBridge(t, { multiSelect: true }), b = realBridge(t, { multiSelect: true });
  await a.start('form-A'); await b.start('form-B');
  await b.callback(a.form());
  await b.callback(b.form(), { messageId: 'old-message' });
  await b.callback(b.form(), { senderId: 'other' });
  assert.equal(a.responses.length, 0); assert.equal(b.responses.length, 0);
  b.sessions.set('p2p:user', 'session-rebound');
  await b.callback(b.form());
  assert.equal(b.responses.length, 0);
});

test('real Bridge rechecks session owner after a callback waited on the conversation queue', real, async t => {
  const gate = deferred(), f = realBridge(t, { responseGate: gate }); await f.start();
  const value = f.value();
  const first = f.callback({ value });
  // Wait only for an explicit controlled RPC boundary, not a wall-clock delay.
  for (let i = 0; i < 100 && f.responses.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.responses.length, 1, 'first authority call entered before invalidation');
  const queued = f.callback({ value: { ...value, choice: 'B' } });
  f.sessions.set('p2p:user', 'session-rebound'); gate.resolve();
  await Promise.all([first, queued]);
  assert.equal(f.responses.length, 1, 'queued old owner never calls original respond');
  assert.equal(f.actionEntries.length, 1, 'Bridge drops queued callback before adapter entry');
});

test('real Bridge + Python sequential rails keep exact SDK message IDs; same-owner token transplant rejected', real, async t => {
  const f = realBridge(t, { questions: [
    { id: 'one', question: 'First', options: [{ label: 'A' }] },
    { id: 'two', question: 'Second', options: [{ label: 'B' }] },
  ] });
  await f.start(); const mainId = f.writes[0].id, firstId = f.writes.at(-1).id, first = f.value();
  await f.callback({ value: first }, { messageId: mainId }); assert.equal(f.responses.length, 0);
  await f.callback({ value: first }, { messageId: firstId }); assert.equal(f.responses.length, 0);
  const secondId = f.writes.at(-1).id, second = f.value(); assert.notEqual(firstId, secondId);
  const oldCard = f.writes.findLast(w => w.id === firstId).card;
  assert.equal(node(oldCard, n => n.value?.hfc_action || n.name?.startsWith('hfc_other_')), null);
  await f.callback({ value: second }, { messageId: firstId });
  await f.callback({ value: first }, { messageId: firstId }); assert.equal(f.responses.length, 0);
  await f.callback({ value: second }, { messageId: secondId });
  await f.callback({ value: second }, { messageId: secondId }); assert.equal(f.responses.length, 1);
  assert.deepEqual(f.responses[0].value.answer.answers, [{ id: 'one', selected: ['A'] }, { id: 'two', selected: ['B'] }]);
  assert.equal(f.actionEntries.at(-1).messageId, secondId, 'actual callback SDK message identity forwarded');
  await f.done();
  assert.equal(f.writes.findLast(w => w.id === mainId).card.schema, '2.0');
  assert.equal(f.writes.findLast(w => w.id === mainId).card.header, undefined);
  assert.equal(node(f.writes.findLast(w => w.id === secondId).card, n => n.value?.hfc_action || n.name?.startsWith('hfc_other_')), null);
});
