import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient } from '../../../src/channels/shared/harness-client.mjs';
import { DshHfcAdapter } from '../../../src/channels/feishu/hfc/adapter.mjs';

const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '1' };
const receipt = { messageId: 'one-card' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = (type, seq, data = {}) => ({ type, seq, data: { turn: 1, ...data } });
const chunk = (seq, text, step = 0) => event('assistant/chunk', seq, { step, chunk: { type: 'text-delta', index: 0, text } });
const canonical = (seq, text, step = 0) => event('assistant/message', seq, { step, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] }, usage: { inputTokens: 10, outputTokens: 20 } });

function harness({ hermesCard = true, onUpdate, onInteraction, initialEvents = [] } = {}) {
  const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:1', workspace: 'fixture' });
  const ready = deferred(), polled = deferred(); let watcher, promptId, history = [], initial = true;
  client.ensureRunning = async () => true;
  client.watchInteractions = async (_id, options) => {
    watcher = options; options.onOpen(); ready.resolve();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  };
  client.rpc = async (method, payload, _timeout, options) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.prompt') { promptId = options.rpcId; return {}; }
    assert.equal(method, 'session.history');
    if (payload.maxMessages === 1) return { events: [] };
    if (initial) {
      initial = false;
      const events = [event('turn/start', 0), event('user/message', 1, { source: { rpcId: promptId } }), event('step/start', 2, { step: 0 }), chunk(3, 'A'), ...initialEvents];
      polled.resolve(); return { events: events.map(event => ({ event })) };
    }
    return { events: history.map(event => ({ event })) };
  };
  return { client, ready, polled, get watcher() { return watcher; },
    end(events = [canonical(4, 'FINAL'), event('turn/end', 5, { reason: { kind: 'completed' } })]) { history = events; },
    ask() { return client.ask('s', 'question', { hermesCard, progressMode: 'live', onUpdate, onInteraction, reasoning: true, timeoutMs: 3000 }); } };
}

function adapterFixture(t, { patchError, signal } = {}) {
  const entered = deferred(), gate = deferred(), cards = [], events = [], updates = [];
  let clock = 0, active = 0, maxActive = 0, patches = 0, state = [];
  const worker = { async start() {}, async close() {}, async reset() { state = []; },
    async event(e) { events.push(e); state.push(e); return { accepted: true, disposition: 'card', segments: [], card: structuredClone(state) }; } };
  const adapter = new DshHfcAdapter({ worker, route, signal, now: () => clock,
    sleep: async ms => { clock += ms; }, sink: {
      async create(card) { cards.push({ kind: 'create', card }); return receipt; },
      async patch(card) {
        active++; maxActive = Math.max(maxActive, active); patches++; clock += 700;
        try {
          cards.push({ kind: 'patch', card });
          if (patches === 1) { entered.resolve(); await gate.promise; }
          if (patchError) throw patchError;
          return receipt;
        } finally { active--; }
      }, async native() { assert.fail('must not send duplicate/native'); },
    } });
  t.after(async () => { gate.resolve(); await adapter.close(); });
  return { adapter, cards, events, updates, entered, gate, advance() { clock += 700; }, get maxActive() { return maxActive; } };
}

for (const burst of [12, 120]) {
  test(`real ask -> Adapter: ${burst} queued snapshots converge without linear slow PATCH backlog`, async t => {
    const f = adapterFixture(t); await f.adapter.start(); f.advance();
    const h = harness({ onUpdate: update => { f.updates.push(update); return f.adapter.onUpdate(update); } });
    const ask = h.ask(); await f.entered.promise;
    for (let i = 0; i < burst; i++) h.watcher.onSessionEvent(chunk(3.1 + i / 1000, 'x'));
    h.end(); f.gate.resolve();
    assert.equal(await ask, 'FINAL'); await f.adapter.finish({ text: 'FINAL' });
    const snapshots = f.updates.filter(u => u.type === 'text');
    assert.ok(snapshots.length <= 3, `expected <=3 full snapshots, got ${snapshots.length}`);
    assert.ok(f.cards.length <= 5, `slow writes must not scale with burst; got ${f.cards.length}`);
    assert.equal(f.cards.filter(c => c.kind === 'create').length, 1);
    assert.equal(f.maxActive, 1);
    assert.equal(f.cards.at(-1).card.at(-1).event, 'message.completed');
    assert.equal(f.cards.at(-1).card.at(-1).data.answer, 'FINAL');
    assert.equal(f.updates.at(-1).type, 'turn-end');
    assert.ok(f.updates.some(u => u.type === 'metrics' && u.outputTokens === 20));
    const count = f.cards.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(f.cards.length, count, 'no stale write after terminal');
  });
}

for (const hermesCard of [true, false]) {
  test(`real ask scheduler preserves step/tool boundaries and legacy FIFO (HFC=${hermesCard})`, async () => {
    const gate = deferred(), entered = deferred(), updates = []; let held = false;
    const initialEvents = [
      ...Array.from({ length: 8 }, (_, i) => chunk(4 + i, 'x')),
      event('tool/call', 12, { name: 'read', callId: 'call' }),
      ...Array.from({ length: 8 }, (_, i) => chunk(13 + i, 'y')),
      event('step/start', 21, { step: 1 }),
      ...Array.from({ length: 8 }, (_, i) => chunk(22 + i, 'z', 1)),
    ];
    const h = harness({ hermesCard, initialEvents, onUpdate: async update => {
      updates.push(update);
      if (!held && update.type === 'text') { held = true; entered.resolve(); await gate.promise; }
    } });
    const pending = h.ask(); await entered.promise;
    if (!hermesCard) for (let i = 0; i < 8; i++) h.watcher.onSessionEvent(event('assistant/chunk', 40 + i,
      { step: 1, chunk: { type: 'reasoning-delta', index: 1, text: `reason-${i}` } }));
    h.end([canonical(30, 'FINAL', 1), event('turn/end', 31, { reason: { kind: 'completed' } })]); gate.resolve();
    await pending;
    assert.equal(updates.filter(u => u.type === 'tool').length, 1);
    const before = updates.slice(0, updates.findIndex(u => u.type === 'tool')).filter(u => u.type === 'text');
    assert.equal(before.at(-1).text.endsWith('x'.repeat(8)), true, 'latest full snapshot before tool survives');
    const after = updates.slice(updates.findIndex(u => u.type === 'tool') + 1).filter(u => u.type === 'text');
    if (hermesCard) {
      assert.equal(before.length, 1); assert.ok(after.some(u => u.step === 0 && u.text.endsWith('y'.repeat(8))));
      assert.ok(after.some(u => u.step === 1));
    } else assert.equal(before.length, 1, 'existing tracker same-history-batch text compaction stays unchanged');
    if (!hermesCard) assert.deepEqual(updates.filter(u => u.type === 'reasoning').map(u => u.text),
      Array.from({ length: 8 }, (_, i) => `reason-${i}`), 'legacy reasoning deltas keep FIFO, not latest-wins');
    assert.equal(updates.at(-1).type, 'turn-end');
  });
}

test('real ask interaction callback is a receipt barrier between snapshot segments', async () => {
  const gate = deferred(), entered = deferred(), interactionEntered = deferred(), interactionGate = deferred();
  const order = []; let held = false;
  const h = harness({ onUpdate: async update => {
    order.push(update);
    if (!held && update.type === 'text') { held = true; entered.resolve(); await gate.promise; }
  }, onInteraction: async () => { order.push('interaction'); interactionEntered.resolve(); await interactionGate.promise; } });
  const ask = h.ask(); await entered.promise;
  h.watcher.onSessionEvent(chunk(3.1, 'BEFORE'));
  const interaction = h.watcher.onInteraction({ kind: 'question' });
  h.watcher.onSessionEvent(chunk(3.2, 'AFTER'));
  h.end(); gate.resolve(); await interactionEntered.promise;
  assert.equal(order.at(-1), 'interaction', 'subsequent updates cannot pass pending interaction display');
  assert.equal(order.at(-2).text, 'ABEFORE');
  interactionGate.resolve(); await interaction; await ask;
  assert.ok(order.slice(order.indexOf('interaction') + 1).some(u => u.text?.includes('AFTER')));
});

test('publisher applies tool FIFO without slow receipt backlog and terminal absorbs unsent draft', async t => {
  const f = adapterFixture(t); await f.adapter.start();
  await f.adapter.onUpdate({ type: 'tool', callId: 'initial', turn: 1 }); await f.entered.promise;
  for (let i = 0; i < 32; i++) {
    await f.adapter.onUpdate({ type: 'tool', callId: `tool-${i}`, turn: 1 });
    await f.adapter.onUpdate({ type: 'tool-result', callId: `tool-${i}`, text: 'ok', turn: 1 });
  }
  assert.equal(f.events.filter(e => e.event === 'tool.updated').length, 65);
  const terminal = f.adapter.finish({ text: 'FINAL' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cards.length, 2, 'terminal waits only one in-flight request');
  f.gate.resolve(); await terminal;
  assert.equal(f.cards.length, 3); assert.equal(f.maxActive, 1);
  assert.equal(f.cards.at(-1).card.filter(e => e.event === 'tool.updated').length, 65);
  await f.adapter.close(); const count = f.cards.length;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.cards.length, count);
});

test('terminal cancels a draft still waiting for the 250ms throttle', async () => {
  let time = 1000, patches = 0, waits = 0; const entered = deferred();
  const adapter = new DshHfcAdapter({ route, minRenderIntervalMs: 0, now: () => time,
    sleep(ms, signal) {
      if (++waits > 1) { time += ms; return Promise.resolve(); }
      entered.resolve(); return new Promise((resolve, reject) => signal.addEventListener('abort',
        () => reject(signal.reason), { once: true }));
    }, worker: { async start() {}, async close() {}, async event() { return { accepted: true, disposition: 'card', segments: [], card: {} }; } },
    sink: { async create() { return receipt; }, async patch() { patches++; return receipt; }, async native() { assert.fail(); } } });
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'tool', callId: 'first' });
    await new Promise(resolve => setTimeout(resolve, 1)); await adapter.publishTail;
    await adapter.onUpdate({ type: 'tool', callId: 'unsent' }); await entered.promise;
    await adapter.finish({ text: 'terminal' });
    assert.equal(patches, 2, 'first draft + terminal; throttled obsolete draft never sends');
    assert.equal(adapter.publishError, undefined); assert.equal(adapter.finished, true);
  } finally { await adapter.close(); }
});

test('close cancels unsent draft before worker close without a late PATCH', async () => {
  let patches = 0, closed = 0;
  const adapter = new DshHfcAdapter({ route, minRenderIntervalMs: 500,
    worker: { async start() {}, async close() { closed++; }, async event() { return { accepted: true, disposition: 'card', segments: [], card: {} }; } },
    sink: { async create() { return receipt; }, async patch() { patches++; return receipt; }, async native() { assert.fail(); } } });
  await adapter.start(); await adapter.onUpdate({ type: 'tool', callId: 'unsent' }); await adapter.close();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(patches, 0); assert.equal(closed, 1);
});
