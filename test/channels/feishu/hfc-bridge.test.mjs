import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { DshHfcAdapter } from '../../../src/channels/feishu/hfc/adapter.mjs';
import { VerifiedFeishuChannel } from '../../../src/channels/feishu/feishu-channel.mjs';
import { hfcDiagnosticFacts } from '../../../src/channels/feishu/hfc-diagnostics.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('expected asynchronous bridge state'); }
function incoming(id = 'in', text = 'test') {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: {
    message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: 'chat', content: JSON.stringify({ text }),
  } };
}
class FakeWorker {
  constructor(options = {}) { this.options = options; this.events = []; this.closed = 0; this.pending = null; }
  async start() { if (this.options.startFails) throw Object.assign(Error('worker closed'), { code: 'worker-exited' }); }
  async reset() { this.pending = null; }
  async close() { this.closed++; }
  async event(event) {
    this.events.push(event);
    if (this.options.failEvent === event.event) throw Object.assign(Error('worker closed'), { code: 'worker-exited' });
    if (event.event === 'interaction.requested') this.pending = { ...event.data, status: 'pending' };
    if (event.event === 'interaction.completed' || event.event === 'interaction.failed') this.pending = { ...this.pending, status: 'completed' };
    const p = this.pending, token = p ? `token-${p.interaction_id}` : null;
    const elements = p?.status === 'pending' ? [
      ...(p.options ?? []).map(option => ({ tag: 'button', value: { hfc_action: 'interaction.select',
        profile_id: event.data.profile_id, interaction_id: p.interaction_id, token, choice: option.value } })),
      ...(p.allow_custom_input ? [{ tag: 'form', name: `hfc_other_${token}` }, { tag: 'form', name: `hfc_confirm_${token}` }] : []),
    ] : [{ tag: 'markdown', content: event.data.answer ?? event.data.text ?? event.event }];
    return { accepted: true, disposition: this.options.native && event.event === 'message.completed' ? 'native' : 'card',
      segments: [], card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: event.event }] } },
      ...(p ? { interaction_card: { elements } } : {}), summary: { interaction: p } };
  }
}
function fixture(ask, options = {}) {
  let sequence = 0;
  const writes = [], posts = [], native = [], calls = [], adapters = [], workers = [], routes = [], diagnostics = [], diagnosticLogs = [];
  const sessions = new Map(options.unbound ? [] : [['p2p:user', 'session-test']]);
  const seen = new Set();
  const emit = async request => {
    calls.push({ kind: 'send', request });
    if (options.sendFails) throw Error('send outcome unknown');
    const id = `message-${++sequence}`;
    if (request.data.msg_type === 'interactive') writes.push({ id, card: JSON.parse(request.data.content) });
    else posts.push(request.data.content);
    return { code: 0, data: options.noSendId ? {} : { message_id: id } };
  };
  const state = { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: key => sessions.get(key),
    setSession: async (key, id) => sessions.set(key, id), clearSession: async key => sessions.delete(key) };
  const verifiedCalls = { cards: [], updates: [], settings: [], recalls: [], replies: [] };
  const verifiedClient = { cardkit: { v1: {
    card: { create: async request => { verifiedCalls.cards.push(request); return { code: 0, data: { card_id: `native-card-${verifiedCalls.cards.length}` } }; },
      settings: async request => { verifiedCalls.settings.push(request); if (options.nativeFinishFails && verifiedCalls.settings.length === 2) throw Error('native finish failed'); return { code: 0 }; } },
    cardElement: { content: async request => { verifiedCalls.updates.push(request); return { code: 0 }; } },
  } }, im: { v1: { message: {
    reply: async request => { verifiedCalls.replies.push(request); return { code: 0, data: { message_id: `native-message-${verifiedCalls.replies.length}` } }; },
    delete: async request => { verifiedCalls.recalls.push(request); return { code: 0 }; },
  } } } };
  const verifiedChannel = options.verifiedNative ? new VerifiedFeishuChannel({ client: verifiedClient }) : null;
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { create: emit, reply: emit, patch: async request => {
      calls.push({ kind: 'patch', request });
      if (options.patchGate) { options.patchGate.entered.resolve(); await options.patchGate.release.promise; }
      if (options.patchFails) throw Error('patch outcome unknown');
      if (options.patchRejected) return { code: 230099, msg: 'PRIVATE provider text' };
      writes.push({ id: request.path.message_id, card: JSON.parse(request.data.content) }); return { code: 0 };
    } } } } },
    channel: verifiedChannel ?? { stream: async (_chat, handlers) => {
      await handlers.markdown({ setContent: async text => native.push(text) });
      return options.nativeUnconfirmed ? { providerMessageIds: [] } : { messageId: 'native-1', providerMessageIds: ['native-1'] };
    } },
    harness: { sessionExists: async () => options.sessionExists !== false, createSession: async () => 'session-new',
      ask: async (id, text, opts) => { calls.push({ kind: 'ask', id, text }); return ask(id, text, opts); } },
    state, status: {}, allowedSenderOpenIds: new Set(['user', 'other']),
    botId: 'bot-test', hfcRuntimeNamespace: options.hfcRuntimeNamespace === undefined ? '11111111-1111-4111-8111-111111111111' : options.hfcRuntimeNamespace,
    stepPush: options.stepPush ?? true, stepPushMode: options.mode ?? 'hermes_card', hfcPresentation: options.presentation ?? { backend: 'hfc', testSessionIds: ['session-test'] },
    signal: options.signal, logger: { warn(tag, facts) { if (tag === '[dsh-feishu-hfc]') diagnosticLogs.push(JSON.parse(facts)); }, info() {}, error() {} },
    hfcDiagnostic: (stage, error, identity) => { diagnostics.push(hfcDiagnosticFacts(stage, error, identity)); return options.hfcDiagnostic?.(stage, error, identity); },
    hfcAdapterFactory: config => { const worker = new FakeWorker(options.worker); workers.push(worker); routes.push(config.route);
      const adapter = new DshHfcAdapter({ ...config, worker }); adapters.push(adapter); return adapter; },
  });
  const run = async (id = 'in') => { await bridge.accept(incoming(id)); await bridge.waitForIdle(); };
  const callback = (action, extra = {}) => bridge.onCardAction({ operator: { open_id: 'user' },
    context: { open_message_id: writes.findLast(w => !w.card.schema)?.id ?? writes[0]?.id, open_chat_id: 'chat' }, action, ...extra });
  return { run, bridge, state, sessions, writes, posts, native, calls, adapters, workers, routes, callback, verifiedCalls, diagnostics, diagnosticLogs };
}
for (const chatType of ['p2p', 'group']) {
  for (const binding of ['existing', 'unbound', 'recovered']) test(`hfc_card handles ${chatType} ${binding} session without whitelist`, async () => {
    const unbound = binding === 'unbound';
    const f = fixture(async (id, _text, options) => { await start(options); return `answer ${id}`; },
      { mode: 'hfc_card', presentation: {backend:'legacy',testSessionIds:[]}, unbound, sessionExists: binding !== 'recovered' });
    const event = incoming(); event.message.chat_type = chatType;
    if (chatType === 'group' && !unbound) f.sessions.set('group:chat', 'group-existing');
    await f.bridge.accept(event); await f.bridge.waitForIdle();
    assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
    assert.equal(f.workers.length, 1);
    assert.equal(f.routes[0].sessionId, binding !== 'existing' ? 'session-new' : chatType === 'p2p' ? 'session-test' : 'group-existing');
    assert.equal(f.native.length, 0);
  });
}

for (const mode of ['post','live_cot','streaming_card','hermes_card','off']) test(`explicit ${mode} supersedes residual HFC whitelist`, async () => {
  const f = fixture(async (_id, _text, options) => { await options.onUpdate({type:'text',step:0,text:'legacy'}); return 'legacy'; });
  if (mode === 'off') f.bridge.setStepPush(false); else f.bridge.setStepPushMode(mode,true);
  await f.run(); assert.equal(f.workers.length,0);
});

test('hot switching freezes in-flight HFC owner and callback authority; next turn uses selected mode', async () => {
  const ready=deferred(), finish=deferred(); let count=0, asks=0;
  const f=fixture(async (_id,_text,options) => {
    if (++asks > 1) { await options.onUpdate({type:'text',step:0,text:'legacy'}); return 'legacy'; }
    await start(options); await options.onInteraction(question(async()=>{ count++; return {accepted:true}; }));
    ready.resolve(); await finish.promise; return 'hfc complete';
  }, {mode:'hfc_card',presentation:{backend:'hfc',testSessionIds:['session-test']}});
  const running=f.run(); await ready.promise; const value=choice(f), owner=f.adapters[0];
  f.bridge.setStepPushMode('hermes_card',true);
  await f.callback({value},{operator:{open_id:'other'}}); assert.equal(count,0);
  await f.callback({value}); assert.equal(count,1); assert.equal(f.adapters[0],owner);
  finish.resolve(); await running;
  assert.equal(f.workers[0].events.at(-1).event,'message.completed');
  await f.run('next'); assert.equal(f.workers.length,1); assert.equal(asks,2);
});

test('all-session HFC never changes sender acceptance or identity fail-closed behavior', async () => {
  const f=fixture(async()=>assert.fail('unauthorized ask'),{mode:'hfc_card',hfcRuntimeNamespace:null});
  const event=incoming(); event.sender.sender_id.open_id='unauthorized';
  await f.bridge.accept(event); await f.bridge.waitForIdle();
  assert.equal(f.calls.filter(c=>c.kind==='ask').length,0);
  await f.run('identity'); assert.equal(f.workers.length,0);
  assert.equal(f.calls.filter(c=>c.kind==='ask').length,0);
});

// A progress update acknowledges state application, not its asynchronous PATCH receipt.
// Hold the actual provider request so after-PATCH fault tests cannot silently test terminal-first publication.
const patchGate = () => ({ entered: deferred(), release: deferred() });
async function completeGatedPatch(fixture, gate) {
  await gate.entered.promise;
  assert.equal(fixture.calls.filter(call => call.kind === 'patch').length, 1);
  const publication = fixture.adapters[0].publishTail;
  gate.release.resolve();
  await publication;
}
const start = options => options.onUpdate({ type: 'turn-start', turn: 73 });
const question = (respond, questions = [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }]) => ({
  kind: 'question', interactionId: 'question-1', rpcId: 'rpc-q', sessionId: 'session-test',
  payload: { sessionId: 'session-test', questions }, respond,
});
function choice(f) { return f.writes.at(-1).card.elements.find(e => e.value)?.value; }

test('HFC uses one ask, actual turn/session identity, strict create then patch and terminal seal', async () => {
  const f = fixture(async (id, _text, options) => {
    assert.equal(id, 'session-test'); assert.equal(options.hermesCard, true); assert.equal(options.reasoning, true);
    assert.equal(options.progressMode, 'all');
    await start(options);
    await options.onUpdate({ type: 'reasoning', turn: 73, step: 0, text: 'reasoning' });
    await options.onUpdate({ type: 'text', turn: 73, step: 0, text: 'partial' });
    await options.onUpdate({ type: 'tool', turn: 73, callId: 'call-a', name: 'read', arguments: '{}' });
    await options.onUpdate({ type: 'tool-result', turn: 73, callId: 'call-a', name: 'read', text: 'ok' });
    await options.onUpdate({ type: 'turn-end', turn: 73, reason: { kind: 'completed' } });
    return 'canonical answer';
  });
  await f.run();
  assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
  assert.equal(f.calls.filter(c => c.kind === 'send' && c.request.data.msg_type === 'interactive').length, 1);
  assert.ok(f.calls.some(c => c.kind === 'patch'));
  assert.deepEqual(f.routes, [{ runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'bot-test', sessionId: 'session-test', chatId: 'chat', senderId: 'user', turnId: '73' }]);
  assert.equal(f.workers[0].events.at(-1).data.answer, 'canonical answer');
  assert.equal(f.workers[0].closed, 1); assert.equal(f.native.length, 0);
});

for (const presentation of [undefined, { backend: 'legacy', testSessionIds: ['session-test'] }, { backend: 'hfc', testSessionIds: [] }]) {
  test(`legacy is retained without explicit HFC test selection: ${JSON.stringify(presentation)}`, async () => {
    const f = fixture(async (_id, _text, options) => { await options.onUpdate({ type: 'text', step: 0, text: 'legacy' }); return 'legacy final'; },
      { presentation: presentation ?? {} });
    await f.run(); assert.equal(f.workers.length, 0); assert.ok(f.writes.length > 0);
  });
}

test('HFC selection rejects recovered binding before any ask and never submits fallback ask', async () => {
  const f = fixture(async () => { assert.fail('must not ask'); }, { sessionExists: false });
  await f.run(); assert.equal(f.calls.filter(c => c.kind === 'ask').length, 0); assert.equal(f.workers.length, 0);
});

test('HFC forwards a real question, validates trusted callback scope, responds once and expires its route', async () => {
  const ready = deferred(), answered = deferred(), finish = deferred(); const responses = [];
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction(question(async response => { responses.push(response); answered.resolve(); return { accepted: true }; }));
    ready.resolve(); await answered.promise; await finish.promise; return 'done';
  });
  const running = f.run(); await ready.promise;
  const value = choice(f);
  await f.callback({ value }, { operator: { open_id: 'other' } });
  await f.callback({ value }, { context: { open_message_id: f.writes[0].id, open_chat_id: 'wrong-chat' } });
  await f.callback({ value: { ...value, profile_id: 'wrong-profile' } });
  assert.equal(responses.length, 0);
  await f.bridge.accept(incoming('plain-pending', 'A')); await until(() => f.posts.length > 0);
  assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1); assert.equal(responses.length, 0);
  await f.callback({ value }); await answered.promise;
  await f.callback({ value }); assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].value.answer.answers, [{ id: 'q', selected: ['A'] }]);
  finish.resolve(); await running;
  await f.callback({ value }); assert.equal(responses.length, 1); assert.equal(f.adapters[0].closed, true);
});

test('HFC rebinding the same conversation invalidates the old card before responder submission', async () => {
  const ready = deferred(), release = deferred(); let responses = 0;
  const f = fixture(async (_id, _text, options) => {
    await start(options);
    await options.onInteraction(question(async () => { responses++; return { accepted: true }; }));
    ready.resolve(); await release.promise; return 'old answer';
  });
  const running = f.run(); await ready.promise; const value = choice(f);
  f.sessions.set('p2p:user', 'session-rebound');
  await f.callback({ value });
  assert.equal(responses, 0);
  assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
  release.resolve(); await running;
  assert.equal(responses, 0);
});

test('HFC form-only multi-select preserves structured selected/custom values', async () => {
  const ready = deferred(), answered = deferred(), finish = deferred(); const responses = [];
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction(question(async response => { responses.push(response); answered.resolve(); return { accepted: true }; },
      [{ id: 'multi', question: 'Choose', multiSelect: true, options: [{ label: 'A,B' }, { label: 'C' }] }]));
    ready.resolve(); await answered.promise; await finish.promise; return 'done';
  });
  const running = f.run(); await ready.promise;
  const name = f.writes.at(-1).card.elements.find(e => e.name?.startsWith('hfc_confirm_')).name;
  await f.callback({ name, form_value: { hfc_multi: ['A,B', 'C'], hfc_other: 'custom,raw' } });
  await answered.promise;
  assert.deepEqual(responses[0].value.answer.answers, [{ id: 'multi', selected: ['A,B', 'C'], custom: 'custom,raw' }]);
  finish.resolve(); await running;
});

test('HFC onInteractionResolved invalidates pending question without submitting DSH respond', async () => {
  let responseCount = 0, oldValue;
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction(question(async () => { responseCount++; })); oldValue = choice(f);
    await options.onInteractionResolved({ kind: 'question', sessionId: 'session-test', interactionId: 'question-1' });
    await f.callback({ value: oldValue }); return 'resolved elsewhere';
  });
  await f.run(); assert.equal(responseCount, 0);
  assert.ok(f.workers[0].events.some(e => e.event === 'interaction.failed'));
});

test('HFC real approval callback goes through original DSH respond closure only once', async () => {
  const ready = deferred(), answered = deferred(), finish = deferred(); const responses = [];
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction({ kind: 'approval', interactionId: 'approval-1', rpcId: 'rpc-a', sessionId: 'session-test',
      payload: { type: 'approval/requested', sessionId: 'session-test', approvalId: 'approval-1', toolName: 'bash', callId: 'call-a', reason: 'build' },
      toolCall: { name: 'bash', callId: 'call-a', arguments: '{"command":"build"}' },
      respond: async response => { responses.push(response); answered.resolve(); return { accepted: true }; } });
    ready.resolve(); await answered.promise; await finish.promise; return 'built';
  });
  const running = f.run(); await ready.promise; const value = choice(f);
  await f.callback({ value }); await answered.promise; await f.callback({ value });
  assert.equal(responses.length, 1); assert.equal(responses[0].value.outcome, 'allowed-once');
  finish.resolve(); await running;
});

for (const failure of ['patchFails', 'sendFails', 'noSendId']) {
  test(`HFC ${failure} never creates a fallback card/native owner or another ask`, async () => {
    const gate = patchGate();
    const f = fixture(async (_id, _text, options) => {
      try {
        await start(options);
        await options.onUpdate({ type: 'tool', callId: 'patch-probe', turn: 73, name: 'read', arguments: '{}' });
      } catch {}
      if (failure === 'patchFails') {
        await completeGatedPatch(f, gate);
        assert.equal(f.adapters[0].publishError?.message, 'patch outcome unknown');
      }
      return 'final';
    }, { [failure]: true, ...(failure === 'patchFails' ? { patchGate: gate } : {}) });
    await f.run();
    assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
    assert.equal(f.calls.filter(c => c.kind === 'send' && c.request.data.msg_type === 'interactive').length, 1);
    assert.equal(f.native.length, 0); assert.equal(f.workers[0].closed, 1);
    assert.ok(!f.workers[0].events.some(e => e.event === 'message.completed'));
  });
}

for (const worker of [{ startFails: true }, { failEvent: 'answer.delta' }]) {
  test(`HFC display-only worker fault retains owner and emits full canonical native once ${JSON.stringify(worker)}`, async () => {
    const f = fixture(async (_id, _text, options) => { await start(options); await options.onUpdate({ type: 'text', turn: 73, step: 0, text: 'partial' }); return 'complete canonical'; }, { worker });
    await f.run(); assert.deepEqual(f.native, ['complete canonical']); assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
  });
}

test('HFC worker-after-patch diagnostic is recorded once despite successful native fallback', async () => {
  const gate = patchGate();
  const f = fixture(async (_id, _text, options) => {
    await start(options);
    await options.onUpdate({ type: 'tool', turn: 73, callId: 'patch', name: 'read', arguments: '{}' });
    await completeGatedPatch(f, gate);
    assert.equal(f.writes.length, 2);
    await options.onUpdate({ type: 'text', turn: 73, step: 0, text: 'PRIVATE partial' });
    return 'canonical';
  }, { worker: { failEvent: 'answer.delta' }, patchGate: gate });
  await f.run();
  assert.ok(f.calls.some(call => call.kind === 'patch'));
  assert.deepEqual(f.native, ['canonical']);
  assert.deepEqual(f.diagnostics, [{ stage: 'worker', code: 'worker-exited', namespaceScope: 'runtime', namespaceSource: 'runtime-random', namespaceCode: 'ready' }]);
  assert.deepEqual(f.diagnosticLogs, f.diagnostics);
});

test('HFC upstream-after-patch failure restores ask rather than retaining the last sink stage', async () => {
  const gate = patchGate();
  const f = fixture(async (_id, _text, options) => {
    await start(options);
    await options.onUpdate({ type: 'tool', turn: 73, callId: 'patch', name: 'read', arguments: '{}' });
    await completeGatedPatch(f, gate);
    assert.equal(f.writes.length, 2);
    throw Error('PRIVATE upstream prompt');
  }, { patchGate: gate });
  await f.run();
  assert.ok(f.calls.some(call => call.kind === 'patch'));
  assert.deepEqual(f.diagnostics, [{ stage: 'ask', code: 'hfc-operation-failed', namespaceScope: 'runtime', namespaceSource: 'runtime-random', namespaceCode: 'ready' }]);
  assert.equal(f.workers[0].closed, 1);
});

test('HFC provider failure inside adapter keeps card.patch stage', async () => {
  const f = fixture(async (_id, _text, options) => {
    await start(options);
    await options.onUpdate({ type: 'tool', turn: 73, callId: 'patch', name: 'read', arguments: '{}' });
    return 'final';
  }, { patchRejected: true });
  await f.run();
  assert.deepEqual(f.diagnostics, [{ stage: 'card.patch', code: 'channel-delivery-failed', providerCode: '230099', namespaceScope: 'runtime', namespaceSource: 'runtime-random', namespaceCode: 'ready' }]);
  assert.equal(f.native.length, 0);
});

test('HFC hanging diagnostic deadline cannot retain a failed turn or prevent worker close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered = false;
  const f = fixture(async (_id, _text, options) => { await start(options); throw Error('PRIVATE upstream'); },
    { hfcDiagnostic: () => { entered = true; return new Promise(() => {}); } });
  let done = false;
  const running = f.run().then(() => { done = true; });
  await until(() => entered);
  t.mock.timers.tick(249); await tick(); assert.equal(done, false);
  t.mock.timers.tick(1); await running;
  assert.equal(f.workers[0].closed, 1);
  assert.equal(f.adapters[0].closed, true);
});

test('HFC terminal worker fault recovered inside finish is still diagnosed once', async () => {
  const f = fixture(async (_id, _text, options) => { await start(options); return 'canonical'; },
    { worker: { failEvent: 'message.completed' } });
  await f.run();
  assert.deepEqual(f.native, ['canonical']);
  assert.deepEqual(f.diagnostics, [{ stage: 'worker', code: 'hfc-operation-failed', namespaceScope: 'runtime', namespaceSource: 'runtime-random', namespaceCode: 'ready' }]);
});

test('HFC native disposition delivers final-only text and never adds a second ask', async () => {
  const f = fixture(async (_id, _text, options) => { await start(options); return 'full native body'; }, { worker: { native: true } });
  await f.run(); assert.deepEqual(f.native, ['full native body']); assert.equal(f.calls.filter(c => c.kind === 'ask').length, 1);
});

test('HFC onInteraction may arrive before turn-start without inventing turn identity', async () => {
  const ready = deferred(), answered = deferred(), finish = deferred(); let count = 0;
  const f = fixture(async (_id, _text, options) => {
    await options.onInteraction(question(async () => { count++; answered.resolve(); return { accepted: true }; }));
    assert.equal(f.workers.length, 0); await start(options); ready.resolve();
    await answered.promise; await finish.promise; return 'early done';
  });
  const running = f.run(); await ready.promise; await f.callback({ value: choice(f) }); await answered.promise;
  finish.resolve(); await running; assert.equal(count, 1); assert.equal(f.routes[0].turnId, '73');
});

test('HFC wrong actual turn aborts owner and never seals successfully even if harness swallows update error', async () => {
  const f = fixture(async (_id, _text, options) => {
    await start(options); try { await options.onUpdate({ type: 'text', turn: 74, step: 0, text: 'wrong' }); } catch {}
    return 'not delivered';
  });
  await f.run(); assert.equal(f.native.length, 0); assert.ok(!f.workers[0].events.some(event => event.event === 'message.completed'));
});

test('HFC aborted owner denies old callback and closes its worker without authority submission', async () => {
  const controller = new AbortController(), ready = deferred(), release = deferred(); let count = 0;
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction(question(async () => { count++; return { accepted: true }; }));
    ready.resolve(); await release.promise; return 'aborted';
  }, { signal: controller.signal });
  const running = f.run(); await ready.promise; const value = choice(f); controller.abort(Error('test stopped'));
  await f.callback({ value }); release.resolve(); await running;
  assert.equal(count, 0); assert.equal(f.adapters[0].closed, true); assert.ok(f.workers[0].closed >= 1);
});

for (const reason of ['stopped', 'interrupted', 'cancelled', 'max-tokens', 'error']) {
  test(`HFC observed ${reason} is never sealed completed when ask returns partial text`, async () => {
    const f = fixture(async (_id, _text, options) => {
      await start(options); await options.onUpdate({ type: 'turn-end', turn: 73, reason: { kind: reason } }); return 'partial';
    });
    await f.run(); assert.equal(f.workers[0].events.at(-1).event, 'message.failed');
  });
}

test('HFC authoritative respond accepted=false remains pending and never submits a second ask from plain text', async () => {
  const ready = deferred(), finish = deferred(); let count = 0;
  const f = fixture(async (_id, _text, options) => {
    await start(options); await options.onInteraction(question(async () => { count++; return { accepted: false }; }));
    ready.resolve(); await finish.promise; return 'stale';
  });
  const running = f.run(); await ready.promise; await f.callback({ value: choice(f) });
  await f.bridge.accept(incoming('not-accepted', 'other answer')); await until(() => f.posts.length > 0);
  assert.equal(count, 1); assert.equal(f.calls.filter(call => call.kind === 'ask').length, 1);
  finish.resolve(); await running;
});

test('HFC actual VerifiedFeishuChannel native sink splits all canonical blocks without losing Unicode/tail', async () => {
  const answer = `${'A'.repeat(28000)}\n\n  ${'中'.repeat(28000)}😀\n尾声  `;
  const f = fixture(async (_id, _text, options) => { await start(options); return answer; }, { worker: { native: true }, verifiedNative: true });
  await f.run(); const c = f.verifiedCalls;
  const chunks = c.cards.map((request, i) => c.updates.findLast(update => update.path.card_id === `native-card-${i + 1}`)?.data.content
    ?? JSON.parse(request.data.data).body.elements[0].content);
  assert.equal(chunks.join(''), answer); assert.equal(chunks.length, 3);
  assert.equal(c.settings.length, chunks.length); assert.equal(c.recalls.length, 0);
  assert.ok(chunks.every(chunk => chunk.length <= 28000 && chunk.isWellFormed()));
  assert.equal(f.calls.filter(call => call.kind === 'ask').length, 1);
});

test('HFC actual native multi-block terminal failure recalls partial cards without second native attempt', async () => {
  const f = fixture(async (_id, _text, options) => { await start(options); return 'A'.repeat(60000); },
    { worker: { native: true }, verifiedNative: true, nativeFinishFails: true });
  await f.run(); const c = f.verifiedCalls;
  assert.equal(c.cards.length, 2); assert.equal(c.settings.length, 2); assert.equal(c.recalls.length, 2);
  assert.equal(f.adapters[0].nativeAttempted, true); assert.equal(f.adapters[0].deliveryFault, true);
  assert.equal(f.calls.filter(call => call.kind === 'ask').length, 1);
});
