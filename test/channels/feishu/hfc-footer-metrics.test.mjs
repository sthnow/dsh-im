import test from 'node:test';
import assert from 'node:assert/strict';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';
import { HarnessReplyTracker } from '../../../src/channels/shared/harness-client.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '1' };
const receipt = { messageId: 'one', providerMessageIds: ['one'] };
const measured = { type: 'metrics', model: 'model-a', provider: 'provider-a', inputTokens: 30, outputTokens: 5 };
function fixture(t, { real = true, initial = 1000, patchUnknown = false } = {}) {
  let clock = initial, creates = 0, patches = 0, natives = 0;
  const cards = [], events = [];
  const raw = real ? new HfcWorker({ python }) : {
    async start() {}, async reset() {}, async close() {},
    async event() { return { accepted: true, disposition: 'card', segments: [], card: {} }; },
  };
  const worker = { start: () => raw.start(), reset: () => raw.reset(), close: () => raw.close(),
    event: async e => { events.push(structuredClone(e)); return raw.event(e); } };
  const adapter = new DshHfcAdapter({ worker, route, now: () => clock, minRenderIntervalMs: 0, minPatchIntervalMs: 0,
    sink: {
      async create(card) { creates++; cards.push(card); return receipt; },
      async patch(card) { patches++; if (patchUnknown) return { ...receipt, status: 'unknown' }; cards.push(card); return receipt; },
      async native() { natives++; return receipt; },
    } });
  t.after(() => adapter.close());
  return { adapter, worker, cards, events, at(value) { clock = value; },
    counts: () => ({ creates, patches, natives }), terminal: () => events.at(-1).data };
}
function footer(card) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.content === 'string' && /已完成|已停止/.test(value.content)) found.push(value.content);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  visit(card); assert.ok(found.length, 'real terminal status footer'); return found.join('\n');
}
const realTest = (name, fn) => test(name, { skip: !python }, fn);

for (const mode of ['success', 'failed', 'interrupted', 'reason-error', 'reason-aborted']) {
  realTest(`real Python + sink terminal footer retains final metrics: ${mode}`, async t => {
    const f = fixture(t); await f.adapter.start();
    await f.adapter.onUpdate(measured);
    assert.equal(f.events.length, 1, 'metrics are not sent to upstream before terminal');
    f.at(3350); await f.adapter.onUpdate({ type: 'turn-end', turn: 1, reason: mode === 'reason-error' ? 'error' : mode === 'reason-aborted' ? 'aborted' : 'completed' });
    f.at(50000); await f.adapter.finish({ text: 'canonical terminal', failed: mode === 'failed', interrupted: mode === 'interrupted' });
    assert.equal(f.terminal().duration, 2.35);
    assert.deepEqual(f.terminal().tokens, { input_tokens: 30, output_tokens: 5 });
    const text = footer(f.cards.at(-1));
    assert.match(text, /provider-a\/model-a/); assert.match(text, /2s/); assert.match(text, /↑30/); assert.match(text, /↓5/);
    assert.doesNotMatch(JSON.stringify(f.cards.at(-1)), /tok\/s/);
    assert.equal(f.events.at(-1).event, mode === 'success' ? 'message.completed' : 'message.failed');
    const counts = f.counts(); await f.adapter.finish({ text: 'do not resend' }); assert.deepEqual(f.counts(), counts);
  });
}

realTest('cumulative snapshots replace rather than add and survive canonical-text worker replay', async t => {
  const f = fixture(t); await f.adapter.start();
  await f.adapter.onUpdate({ ...measured, inputTokens: 10, outputTokens: 2 });
  await f.adapter.onUpdate({ type: 'text', step: 0, text: 'draft' });
  await f.adapter.onUpdate(measured);
  await f.adapter.onUpdate({ type: 'text', step: 0, text: 'edited' });
  await f.adapter.onUpdate(measured);
  f.at(3000); await f.adapter.finish({ text: 'final' });
  assert.deepEqual(f.terminal().tokens, { input_tokens: 30, output_tokens: 5 });
  assert.match(footer(f.cards.at(-1)), /↓5/); assert.doesNotMatch(footer(f.cards.at(-1)), /↓(7|10)/);
  assert.equal(f.counts().creates, 1);
  assert.ok(f.events.filter(e => e.event !== 'message.completed').every(e => !('tokens' in e.data) && !('model' in e.data)));
});

for (const failed of [false, true]) {
  realTest(`empty snapshot clears partial model and usage before ${failed ? 'failure' : 'success'}`, async t => {
    const f = fixture(t); await f.adapter.start(); await f.adapter.onUpdate(measured);
    await f.adapter.onUpdate({ type: 'metrics' }); f.at(3000); await f.adapter.finish({ text: 'terminal', failed });
    assert.equal('tokens' in f.terminal(), false); assert.equal('model' in f.terminal(), false);
    assert.equal('provider' in f.terminal(), false);
    const text = footer(f.cards.at(-1)); assert.match(text, /2s/); assert.doesNotMatch(text, /model-a|provider-a|↑|↓/);
  });
}

realTest('no metrics never fabricates token zero or guesses a model from text', async t => {
  const f = fixture(t); await f.adapter.start();
  await f.adapter.onUpdate({ type: 'text', text: 'model-a with lots of characters '.repeat(10) });
  f.at(4000); await f.adapter.finish({ text: 'final' });
  assert.equal('tokens' in f.terminal(), false); assert.equal('model' in f.terminal(), false);
  assert.doesNotMatch(footer(f.cards.at(-1)), /↑|↓|model-a/);
});

realTest('legitimate zero counts are forwarded and displayed on successful completion', async t => {
  const f = fixture(t); await f.adapter.start(); await f.adapter.onUpdate({ ...measured, inputTokens: 0, outputTokens: 0 });
  f.at(2000); await f.adapter.finish({ text: 'done' });
  assert.deepEqual(f.terminal().tokens, { input_tokens: 0, output_tokens: 0 });
  assert.match(footer(f.cards.at(-1)), /↑0/); assert.match(footer(f.cards.at(-1)), /↓0/);
});

realTest('failure preserves zero in event contract but pinned upstream omits zero token fields', async t => {
  const f = fixture(t); await f.adapter.start(); await f.adapter.onUpdate({ ...measured, inputTokens: 0, outputTokens: 0 });
  f.at(2000); await f.adapter.finish({ text: 'stopped', interrupted: true });
  assert.deepEqual(f.terminal().tokens, { input_tokens: 0, output_tokens: 0 });
  assert.match(footer(f.cards.at(-1)), /provider-a\/model-a/); assert.doesNotMatch(footer(f.cards.at(-1)), /↑|↓/);
});

realTest('invalid fields are omitted without numeric/string coercion; valid independent fields survive', async t => {
  const f = fixture(t); await f.adapter.start();
  for (const value of [-1, 1.2, NaN, Infinity, '4', true, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await f.adapter.onUpdate({ type: 'metrics', inputTokens: value, outputTokens: value, model: 12, provider: [] });
    assert.deepEqual(f.adapter.metrics, {});
  }
  await f.adapter.onUpdate({ type: 'metrics', inputTokens: 0, outputTokens: '5', model: '   ', provider: false, duration: 9999, rate: 100 });
  f.at(2500); await f.adapter.finish({ text: 'done' });
  assert.deepEqual(f.terminal().tokens, { input_tokens: 0 });
  assert.equal(f.terminal().duration, 1.5); assert.equal('model' in f.terminal(), false); assert.equal('rate' in f.terminal(), false);
  assert.match(footer(f.cards.at(-1)), /↑0/); assert.doesNotMatch(footer(f.cards.at(-1)), /↓|Unknown|tok\/s/);
});

test('wrong turn cannot replace metrics or freeze the duration; repeated start and end do not reset timing', async t => {
  const f = fixture(t, { real: false }); await f.adapter.start(); await f.adapter.onUpdate(measured);
  f.at(1500); await f.adapter.start();
  await assert.rejects(f.adapter.onUpdate({ type: 'metrics', turn: 2 }), /wrong-turn/);
  await assert.rejects(f.adapter.onUpdate({ type: 'turn-end', turn: 2 }), /wrong-turn/);
  f.at(3500); await f.adapter.onUpdate({ type: 'turn-end', turn: 1 });
  f.at(8000); await f.adapter.onUpdate({ type: 'turn-end', turn: 1 });
  f.at(9000); await f.adapter.finish({ text: 'done' });
  assert.equal(f.terminal().duration, 2.5); assert.deepEqual(f.terminal().tokens, { input_tokens: 30, output_tokens: 5 });
});

for (const [initial, end, expected] of [[1000, 1000, 0], [1000, 4000, 3], [1000, 999, undefined], [NaN, 2000, undefined], [1000, Infinity, undefined], ['1000', 2000, undefined], [1000, null, undefined]]) {
  test(`local duration validates samples and preserves real zero (${String(initial)} to ${String(end)})`, async t => {
    const f = fixture(t, { real: false, initial }); await f.adapter.start(); f.at(end);
    await f.adapter.onUpdate({ type: 'turn-end', turn: 1 }); f.at(99000); await f.adapter.finish({ text: 'done' });
    assert.equal(f.terminal().duration, expected); assert.equal('duration' in f.terminal(), expected !== undefined);
  });
}

test('end and finish sample their synchronous entry before serial work and terminal PATCH delay', async t => {
  for (const withEnd of [true, false]) {
    const f = fixture(t, { real: false }); await f.adapter.start();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
    const original = f.worker.event;
    f.worker.event = async e => { if (e.event === 'tool.updated') { entered(); await gate; } return original(e); };
    const busy = f.adapter.onUpdate({ type: 'tool', callId: 'wait', name: 'read' }); await ready;
    f.at(4000); const end = withEnd ? f.adapter.onUpdate({ type: 'turn-end', turn: 1 }) : null;
    const terminal = f.adapter.finish({ text: 'done' }); f.at(90000); release();
    await busy; await end; await terminal; assert.equal(f.terminal().duration, 3);
  }
});

realTest('unknown terminal PATCH is never resent or replaced by another owner', async t => {
  const f = fixture(t, { patchUnknown: true }); await f.adapter.start(); await f.adapter.onUpdate(measured); f.at(2000);
  await assert.rejects(f.adapter.finish({ text: 'terminal' }), /card-delivery-unconfirmed/);
  await assert.rejects(f.adapter.finish({ text: 'terminal' }), /terminal-already-attempted/);
  assert.deepEqual(f.counts(), { creates: 1, patches: 1, natives: 0 });
  assert.deepEqual(f.terminal().tokens, { input_tokens: 30, output_tokens: 5 });
});

for (const kind of ['same-route', 'mixed-route', 'untrusted-step']) {
  realTest(`real HarnessReplyTracker to adapter to Python sink: ${kind}`, async t => {
    const f = fixture(t), promptRpcId = 'footer-fixture';
    const tracker = new HarnessReplyTracker({ promptRpcId, hermesCard: true, reasoning: true });
    const event = (type, seq, data = {}) => ({ type, seq, time: 1794750000000 + seq, data: { turn: 1, ...data } });
    const message = (seq, step, modelSource, usage) => event('assistant/message', seq, { step,
      message: { source: modelSource, content: [{ type: 'text', text: `canonical-${step}` }] }, usage });
    const source = { kind: 'model', provider: 'provider-a', model: 'model-a' };
    const entries = [event('turn/start', 1), event('user/message', 2, { source: { rpcId: promptRpcId } }),
      message(3, 0, source, { inputTokens: 10, outputTokens: 2 }),
      message(4, 1, kind === 'mixed-route' ? { ...source, model: 'model-b' } : kind === 'untrusted-step' ? { kind: 'unknown' } : source,
        { inputTokens: 20, outputTokens: 3 }), event('turn/end', 5, { reason: { kind: 'completed' } })];
    await f.adapter.start();
    for (const update of tracker.consumeAll(entries)) { if (update.type === 'turn-end') f.at(4000); await f.adapter.onUpdate(update); }
    assert.deepEqual(tracker.consumeAll(entries), [], 'durable replay is deduplicated');
    await f.adapter.finish({ text: tracker.answer }); const text = footer(f.cards.at(-1));
    if (kind === 'untrusted-step') { assert.equal('tokens' in f.terminal(), false); assert.doesNotMatch(text, /↑|↓|model-a/); }
    else { assert.deepEqual(f.terminal().tokens, { input_tokens: 30, output_tokens: 5 }); assert.match(text, /↑30/); assert.match(text, /↓5/); }
    if (kind === 'same-route') assert.match(text, /provider-a\/model-a/);
    else { assert.equal('model' in f.terminal(), false); assert.doesNotMatch(text, /provider-a|model-a|model-b/); }
    assert.match(text, /3s/); assert.doesNotMatch(JSON.stringify(f.cards.at(-1)), /tok\/s/);
  });
}
