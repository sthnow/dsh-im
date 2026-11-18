import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient, HarnessReplyTracker } from '../../../src/channels/shared/harness-client.mjs';
import { observedStreamWindow } from '../../../src/channels/shared/hfc-display-metrics.mjs';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';
const python = process.env.DSH_HFC_TEST_PYTHON;
const base = 1794750000000, promptRpcId = 'context-rate';
const source = { kind: 'model', provider: 'provider-a', model: 'model-a' };
const event = (type, seq, data = {}) => ({ type, seq, time: base + seq, data: { turn: 1, ...data } });
const prefix = () => [event('turn/start', 0), event('user/message', 1, { source: { rpcId: promptRpcId } })];
const raw = (time, chunk) => ({ type: 'chunk', time, chunk });
function stream({ start = base, ms = 1000, packed = true, type = 'text', index = 0 } = {}) {
  const tool = type === 'tool-call';
  return [raw(start, { type: 'block-start', index, blockType: type }),
    ...(packed ? [{ type: tool ? 'tool-call-chunks' : `${type}-chunks`, time0: start + 10, index, dt: [10],
      ...(tool ? { args: ['{', '}'], id: 'call' } : { texts: ['a', 'b'] }) }]
      : [raw(start + 10, { type: `${type}-delta`, index, text: 'a' }), raw(start + 20, { type: `${type}-delta`, index, text: 'b' })]),
    raw(start + ms - 1, { type: 'block-end', index, block: { type, ...(tool ? { id: 'call' } : { text: 'ab' }) } }),
    raw(start + ms, { type: 'finish', reason: { kind: 'stop' } })];
}
function message(seq = 3, step = 0, data = {}) {
  return event('assistant/message', seq, { step, message: { source, content: [{ type: 'text', text: 'answer' }] },
    usage: { inputTokens: 5000, outputTokens: 40 }, stream: stream(), ...data });
}
const end = (seq = 5, reason = 'completed') => event('turn/end', seq, { reason: { kind: reason } });
const snapshot = (data = {}) => ({ asOfSeq: 5, turn: 1, step: 0, messageSeq: 3, provider: source.provider,
  model: source.model, contextTokens: 250, contextWindow: 1000, ...data });
const hermes = () => new HarnessReplyTracker({ promptRpcId, hermesCard: true });
const metrics = updates => updates.filter(update => update.type === 'metrics').at(-1);
const complete = (msg = message(), terminal = end()) => [...prefix(), event('step/start', 2, { step: 0 }), msg, event('step/end', 4, { step: 0 }), terminal];

test('raw and packed observed streams use first record to finish, with tool and reasoning records', () => {
  for (const packed of [false, true]) assert.deepEqual(observedStreamWindow(stream({ packed })), { start: base, end: base + 1000, seconds: 1 });
  for (const type of ['reasoning', 'tool-call']) assert.equal(observedStreamWindow(stream({ type })).seconds, 1);
  const tool = stream({ type: 'tool-call' });
  tool[1] = raw(base + 10, { type: 'tool-call-delta', index: 0, id: 'call', name: 'read', argumentsDelta: '{}' });
  assert.equal(observedStreamWindow(tool).seconds, 1);
  tool[1].chunk.id = 'other'; assert.equal(observedStreamWindow(tool), null);
  const s = stream(); s[1].texts = ['a']; s[1].dt = [];
  assert.equal(observedStreamWindow(s).seconds, 1, 'one-member packed record is valid among complete controls');
});

test('strict clock, index, packed length, known type and finish validation', () => {
  const bad = [s => s[1].dt.push(2), s => s[1].dt.pop(), s => s[1].dt[0] = -1,
    s => s[1].dt[0] = Infinity, s => s[1].dt[0] = NaN, s => s[1].dt[0] = '10',
    s => s[1].time0 = base - 1, s => s[1].time0 = Infinity, s => s[1].index = 1,
    s => s[0].chunk.index = 1, s => s[2].chunk.index = 2, s => s[2].chunk.block.type = 'reasoning',
    s => s[1].type = 'future-chunks', s => s[1].texts[0] = 1, s => s[1].texts = [],
    s => s.pop(), s => s.shift(), s => s.splice(2, 1), s => s.push(s.at(-1)),
    s => s.at(-1).time = base - 1, s => s.at(-1).chunk.reason.kind = 'aborted',
    s => s.splice(1, 0, raw(base + 1, { type: 'future' })),
    s => s.at(-1).time = base + 3600000];
  for (const mutate of bad) { const s = stream(); mutate(s); assert.equal(observedStreamWindow(s), null, String(mutate)); }
  assert.equal(observedStreamWindow([raw(base, { type: 'finish', reason: { kind: 'stop' } })]), null);
  const s = stream(); s[1].dt = [0]; assert.equal(observedStreamWindow(s).seconds, 1);
  for (const scale of [0.001, 1000, 1e6]) {
    const wrongUnit = stream();
    for (const record of wrongUnit) {
      if (record.type === 'chunk') record.time *= scale;
      else { record.time0 *= scale; record.dt = record.dt.map(dt => dt * scale); }
    }
    assert.equal(observedStreamWindow(wrongUnit), null, `wrong epoch clock scale ${scale}`);
  }
  assert.equal(observedStreamWindow([raw(base, { type: 'usage', usage: { outputTokens: 40 } }), raw(base + 1000, { type: 'finish', reason: { kind: 'stop' } })]), null);
  const empty = stream(); empty.splice(1, 1); assert.equal(observedStreamWindow(empty), null);
  const blank = stream(); blank[1].texts = ['', '']; assert.equal(observedStreamWindow(blank), null);
});

for (const [output, ms, expected] of [[19, 300, false], [20, 299, false], [20, 300, true], [20, 301, true], [1000000, 1000, false]]) {
  test(`rate minimum output/time and upper bound: ${output}/${ms}`, () => {
    const update = metrics(hermes().consumeAll(complete(message(3, 0, { usage: { outputTokens: output }, stream: stream({ ms }) }))));
    assert.equal(Boolean(update.rate), expected);
    if (expected) assert.equal(update.rate.output_tps, output / (ms / 1000));
  });
}

test('weighted multiple steps exclude tool waiting, replay dedupes by durable seq', () => {
  const tracker = hermes();
  const entries = [...prefix(), message(), event('tool/call', 4, { step: 0, name: 'read', callId: 'c' }),
    event('tool/result', 5, { step: 0, message: { toolCallId: 'c', content: [] } }),
    message(6, 1, { stream: stream({ start: base + 600000, ms: 3000 }), usage: { inputTokens: 7000, outputTokens: 80 } }), end(7)];
  const update = metrics(tracker.consumeAll(entries)); assert.deepEqual(update.rate, { output_tps: 30, basis: 'decode' });
  assert.equal(update.inputTokens, 12000); assert.equal(update.outputTokens, 120);
  assert.deepEqual(tracker.consumeAll(entries), []);
});

for (const kind of ['missing-step', 'duplicate-invocation', 'mixed-route', 'attempt', 'interrupted', 'unknown-step', 'failed', 'no-finish', 'foreign-source', 'overlap']) {
  test(`unsafe observed rate is hidden: ${kind}`, () => {
    const tracker = hermes(); let entries = [...prefix(), message()];
    if (kind === 'missing-step') entries.push(event('step/start', 4, { step: 1 }));
    if (kind === 'duplicate-invocation') entries.push(message(4));
    if (kind === 'mixed-route') entries.push(message(4, 1, { message: { source: { ...source, model: 'b' }, content: [] } }));
    if (kind === 'attempt') entries.push(event('assistant/attempt', 4, { step: 0, stream: stream() }));
    if (kind === 'interrupted') entries[2].data.interrupted = true;
    if (kind === 'unknown-step') delete entries[2].data.step;
    if (kind === 'no-finish') entries[2].data.stream.pop();
    if (kind === 'foreign-source') entries[2].data.message.source = { kind: 'other' };
    if (kind === 'overlap') entries.push(message(4, 1));
    entries.push(end(5, kind === 'failed' ? 'error' : 'completed'));
    assert.equal(metrics(tracker.consumeAll(entries)).rate, undefined);
  });
}

test('terminal context is independently Host pressure, emitted before end, not cumulative input', () => {
  const tracker = hermes(); const updates = tracker.consumeAll(complete(), { terminalDisplay: snapshot() });
  assert.deepEqual(metrics(updates).context, { used_tokens: 250, max_tokens: 1000 });
  assert.equal(metrics(updates).inputTokens, 5000);
  assert.equal(updates.at(-1).type, 'turn-end'); assert.equal(updates.at(-2).type, 'metrics');
  assert.deepEqual(tracker.consumeAll(complete(), { terminalDisplay: snapshot() }), []);
});

for (const field of [{ asOfSeq: 4 }, { asOfSeq: 6 }, { turn: 2 }, { step: 1 }, { messageSeq: 4 }, { model: 'b' },
  { provider: 'b' }, { contextTokens: -1 }, { contextTokens: '250' }, { contextWindow: 0 }, { contextWindow: Infinity }]) {
  test(`invalid terminal snapshot ${JSON.stringify(field)}`, () => {
    assert.equal(metrics(hermes().consumeAll(complete(), { terminalDisplay: snapshot(field) })).context, undefined);
  });
}

test('stale latest history, new turns, failed ends, mux metadata and event metadata never provide context', () => {
  for (const entries of [[...complete(), event('turn/start', 6, { turn: 2 })], [...complete(), event('custom', 6)], complete(message(), end(5, 'error'))]) {
    assert.equal(metrics(hermes().consumeAll(entries, { terminalDisplay: snapshot() })).context, undefined);
  }
  const tracker = hermes(); tracker.consumeAll(prefix());
  assert.deepEqual(tracker.consumeAll(complete(), { fromMux: true, terminalDisplay: snapshot() }), []);
  const entries = complete(); entries.at(-1).data.terminalDisplay = snapshot();
  assert.equal(metrics(tracker.consumeAll(entries)).context, undefined);
});

test('late history compensation after finish validates exact historical identity once', () => {
  const tracker = hermes(); tracker.consumeAll(complete());
  assert.deepEqual(metrics(tracker.consumeAll(complete(), { terminalDisplay: snapshot() })).context, { used_tokens: 250, max_tokens: 1000 });
  assert.deepEqual(tracker.consumeAll(complete(), { terminalDisplay: snapshot() }), []);
});

test('non-Hermes tracker remains unchanged despite terminal metadata and valid observed stream', () => {
  const a = new HarnessReplyTracker({ promptRpcId }), b = new HarnessReplyTracker({ promptRpcId });
  assert.deepEqual(a.consumeAll(complete(), { terminalDisplay: snapshot() }), b.consumeAll(complete()));
  assert.equal(a.consumeAll(complete()).some(update => update.type === 'metrics'), false);
});

for (const mode of ['hermes', 'legacy', 'paged', 'incomplete']) {
  test(`real HarnessClient.ask history boundary preserves only latest complete opt-in snapshot: ${mode}`, async () => {
    const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:1', workspace: 'fixture' });
    const updates = [], calls = []; let promptId, incompletePoll = 0;
    const controller = new AbortController();
    client.ensureRunning = async () => true;
    client.watchInteractions = async (_id, { onOpen, signal, onSessionEvent }) => {
      onOpen();
      // Even a durable-looking live end cannot complete the tracker or inject context.
      onSessionEvent?.({ event: end(), terminalDisplay: snapshot({ contextTokens: 999 }) });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    };
    client.rpc = async (method, payload, _timeout, options) => {
      if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
      if (method === 'session.prompt') { promptId = options.rpcId; return {}; }
      assert.equal(method, 'session.history'); calls.push(payload);
      if (payload.maxMessages === 1) return { events: [] };
      const entries = complete(); entries[1].data.source.rpcId = promptId;
      const wrap = list => list.map(event => ({ event }));
      if (mode === 'incomplete' && incompletePoll++ < 2) return { events: [], hasMore: true, terminalDisplay: snapshot() };
      if (mode === 'paged' && payload.beforeSeq === undefined) return { events: wrap(entries.slice(3)), hasMore: true, terminalDisplay: snapshot() };
      if (mode === 'paged') return { events: wrap(entries.slice(0, 3)), hasMore: false, terminalDisplay: snapshot({ contextTokens: 999 }) };
      return { events: wrap(entries), hasMore: false, terminalDisplay: snapshot() };
    };
    const answer = await client.ask('fixture-session', 'question', { hermesCard: mode !== 'legacy', progressMode: 'all', signal: controller.signal,
      onUpdate: update => updates.push(update), timeoutMs: 3000 });
    assert.equal(answer, 'answer');
    const latestCalls = calls.filter(call => call.maxMessages === 50 && call.beforeSeq === undefined);
    assert.ok(latestCalls.length > 0);
    for (const call of latestCalls) assert.equal(call.terminalDisplay, mode === 'legacy' ? undefined : true);
    for (const call of calls.filter(call => call.beforeSeq !== undefined)) assert.equal(call.terminalDisplay, undefined);
    if (mode === 'legacy') assert.equal(metrics(updates), undefined);
    else {
      assert.deepEqual(metrics(updates).context, { used_tokens: 250, max_tokens: 1000 });
      assert.equal(updates.at(-1).type, 'turn-end'); assert.equal(updates.at(-2).type, 'metrics');
      assert.equal(updates.filter(update => update.type === 'turn-end').length, 1);
    }
  });
}

const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '1' };
function adapterFixture(t, real = false) {
  const events = [], cards = [];
  const rawWorker = real ? new HfcWorker({ python }) : { async start() {}, async close() {}, async reset() {},
    async event() { return { accepted: true, disposition: 'card', segments: [], card: {} }; } };
  const worker = { start: () => rawWorker.start(), close: () => rawWorker.close(), reset: () => rawWorker.reset(),
    async event(e) { events.push(e); return rawWorker.event(e); } };
  const sink = async card => { cards.push(card); return { messageId: 'one' }; };
  const adapter = new DshHfcAdapter({ worker, route, minRenderIntervalMs: 0, minPatchIntervalMs: 0,
    sink: { create: sink, patch: sink, native: sink } });
  t.after(() => adapter.close()); return { adapter, events, cards };
}

test('adapter strictly whitelists metrics and restricts context/rate to success', async t => {
  for (const failed of [false, true]) {
    const f = adapterFixture(t); await f.adapter.start();
    await f.adapter.onUpdate({ type: 'metrics', inputTokens: 4, outputTokens: 20, output_tps: 123, tokens: { output_tps: 456 },
      rate: { output_tps: 40, basis: 'decode', injected: 'no' }, context: { used_tokens: 2, max_tokens: 10, injected: 'no' } });
    await f.adapter.finish({ text: 'done', failed }); const data = f.events.at(-1).data;
    assert.deepEqual(data.tokens, { input_tokens: 4, output_tokens: 20 }); assert.equal(data.output_tps, undefined);
    assert.deepEqual(data.rate, failed ? undefined : { output_tps: 40, basis: 'decode' });
    assert.deepEqual(data.context, failed ? undefined : { used_tokens: 2, max_tokens: 10 });
  }
});

test('empty and invalid snapshots retract context/rate without token-field throughput injection', async t => {
  const f = adapterFixture(t); await f.adapter.start();
  for (const update of [{ rate: { output_tps: 4, basis: 'decode' }, context: { used_tokens: 2, max_tokens: 10 } }, {},
    { rate: { output_tps: '4', basis: 'decode' }, context: { used_tokens: 2, max_tokens: 0 } },
    { rate: { output_tps: 4, basis: 'prefill' } }, { inputTokens: 20, outputTokens: 40, tokens: { output_tps: 999 } }]) {
    await f.adapter.onUpdate({ type: 'metrics', ...update });
    if (!update.context || update.context.max_tokens === 0) assert.equal(f.adapter.metrics.context, undefined);
    if (!update.rate || typeof update.rate.output_tps !== 'number' || update.rate.basis !== 'decode') assert.equal(f.adapter.metrics.rate, undefined);
  }
  await f.adapter.finish({ text: 'done' }); assert.equal(f.events.at(-1).data.rate, undefined);
});

test('real Tracker -> Adapter -> pinned Python footer renders independent ctx percent and observed ~tok/s', { skip: !python }, async t => {
  const tracker = hermes(), f = adapterFixture(t, true); await f.adapter.start();
  for (const update of tracker.consumeAll(complete(), { terminalDisplay: snapshot() })) await f.adapter.onUpdate(update);
  await f.adapter.finish({ text: tracker.answer });
  const card = JSON.stringify(f.cards.at(-1));
  assert.match(card, /25%/); assert.match(card, /~40(?:\.0)? tok\/s/);
  assert.equal(f.cards.at(-1).header, undefined, 'worker retains header suppression');
  assert.deepEqual(f.events.at(-1).data.context, { used_tokens: 250, max_tokens: 1000 });
});

test('real pinned Python failure footer never displays success-only context or rate', { skip: !python }, async t => {
  const f = adapterFixture(t, true); await f.adapter.start();
  await f.adapter.onUpdate({ type: 'metrics', model: 'model-a', provider: 'provider-a', inputTokens: 5000, outputTokens: 40,
    rate: { output_tps: 40, basis: 'decode' }, context: { used_tokens: 250, max_tokens: 1000 } });
  await f.adapter.finish({ text: 'failed', failed: true });
  const card = JSON.stringify(f.cards.at(-1));
  assert.doesNotMatch(card, /tok\/s|ctx 250|25%/);
  assert.equal(f.cards.at(-1).header?.template, 'red', 'failure header keeps the established worker status contract');
  assert.equal(f.events.at(-1).event, 'message.failed');
  assert.equal(f.events.at(-1).data.rate, undefined);
  assert.equal(f.events.at(-1).data.context, undefined);
});
