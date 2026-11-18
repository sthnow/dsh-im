import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessClient, HarnessReplyTracker } from '../../../src/channels/shared/harness-client.mjs';

const promptRpcId = 'hermes-fixture';
const source = { kind: 'model', model: 'model-a', provider: 'provider-a' };
const event = (type, seq, data = {}) => ({ type, seq, time: 1794750000000 + seq, data: { turn: 1, ...data } });
const prefix = () => [event('turn/start', 1), event('user/message', 2, { source: { rpcId: promptRpcId } })];
const delta = (seq, step, text, type = 'text-delta') => event('assistant/chunk', seq, { step, chunk: { type, index: 0, text } });
function message(seq, step, { text = 'answer', reasoning, usage, modelSource = source } = {}) {
  return event('assistant/message', seq, {
    step, message: { source: modelSource, content: [
      ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
      { type: 'text', text },
    ] },
    stream: [{ type: 'text-chunks', time0: 1794750000000, index: 0, dt: [0, 10], texts: ['ans', 'wer'] }],
    ...(usage === undefined ? {} : { usage }),
  });
}
const hermes = (options = {}) => new HarnessReplyTracker({ promptRpcId, hermesCard: true, reasoning: true, ...options });
const metrics = (updates) => updates.filter((update) => update.type === 'metrics');

function fixture() {
  return [...prefix(), delta(3, 0, 'draft'),
    message(4, 0, { text: 'preamble', reasoning: 'think', usage: { inputTokens: 10, outputTokens: 2 } }),
    event('tool/call', 5, { step: 0, name: 'read', callId: 'real-call', arguments: '{}' }),
    event('tool/result', 6, { step: 0, message: { toolCallId: 'real-call', source: { kind: 'tool', callId: 'real-call' }, content: [{ type: 'text', text: 'failed' }], isError: true }, error: { name: 'Error', code: 'EACCES' } }),
    message(7, 1, { text: 'final', usage: { inputTokens: 20, outputTokens: 3 } }),
    event('turn/end', 8, { reason: { kind: 'completed' } })];
}

const legacyHistory = [
  { type: 'text', text: 'draft' },
  { type: 'assistant-message', step: 0, text: 'preamble' },
  { type: 'text', text: 'preamble' },
  { type: 'tool', name: 'read', arguments: '{}', callId: 'real-call' },
  { type: 'status', text: '正在整理结果…', toolName: 'read', error: 'Error: EACCES' },
  { type: 'assistant-message', step: 1, text: 'final' },
  { type: 'text', text: 'preamble\n\nfinal' },
];

for (const hermesCard of [undefined, false, 'true', 1]) {
  test(`Hermes opt-in is strict; legacy history remains byte-for-byte identical (${String(hermesCard)})`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId, hermesCard });
    assert.deepEqual(tracker.consumeAll(fixture()), legacyHistory);
    assert.equal(tracker.answer, 'preamble\n\nfinal');
  });
}

test('default live event contract and existing reasoning opt-in remain unchanged', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId });
  const expected = [
    { type: 'turn-start', turn: 1 },
    { type: 'text', text: 'draft' },
    { type: 'assistant-message', step: 0, text: 'preamble', turn: 1 },
    { type: 'text', text: 'preamble' },
    { type: 'tool', name: 'read', arguments: '{}', callId: 'real-call', turn: 1 },
    { type: 'tool-result', turn: 1, callId: 'real-call', toolName: 'read', text: 'failed', errorCode: 'EACCES' },
    { type: 'assistant-message', step: 1, text: 'final', turn: 1 },
    { type: 'text', text: 'preamble\n\nfinal' },
    { type: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ];
  assert.deepEqual(tracker.consumeAll(fixture(), { live: true }), expected);
  const reasoningTracker = new HarnessReplyTracker({ promptRpcId, reasoning: true });
  const updates = reasoningTracker.consumeAll(fixture());
  assert.deepEqual(updates, [...legacyHistory.slice(0, 2), { type: 'reasoning', step: 0, text: 'think' }, ...legacyHistory.slice(2)]);
});

test('Hermes history emits step drafts, canonical reasoning, real call IDs, failed results and round metrics', () => {
  const tracker = hermes();
  const updates = tracker.consumeAll(fixture());
  assert.deepEqual(updates, [
    { type: 'turn-start', turn: 1 },
    { type: 'text', step: 0, text: 'draft' },
    { type: 'assistant-message', step: 0, text: 'preamble' },
    { type: 'reasoning', step: 0, text: 'think' },
    { type: 'text', step: 0, text: 'preamble' },
    { type: 'metrics', inputTokens: 10, outputTokens: 2, model: 'model-a', provider: 'provider-a' },
    { type: 'tool', name: 'read', arguments: '{}', callId: 'real-call' },
    { type: 'tool-result', turn: 1, callId: 'real-call', toolName: 'read', text: 'failed', isError: true, error: 'Error: EACCES', errorCode: 'EACCES' },
    { type: 'assistant-message', step: 1, text: 'final' },
    { type: 'text', step: 1, text: 'final' },
    { type: 'metrics', inputTokens: 30, outputTokens: 5, model: 'model-a', provider: 'provider-a' },
    { type: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ]);
  assert.equal(tracker.answer, 'preamble\n\nfinal');
  assert.equal(tracker.finished, true);
  assert.deepEqual(tracker.reason, { kind: 'completed' });
  assert.equal('isError' in updates.find((update) => update.type === 'tool'), false, 'a call is not success');
});

test('Hermes preserves separate steps in one draft batch, coalesces only the same step and replaces canonical text', () => {
  const tracker = hermes();
  const updates = tracker.consumeAll([...prefix(), delta(3, 0, 'a'), delta(4, 0, 'b'), delta(5, 1, 'ab')]);
  assert.deepEqual(updates, [{ type: 'turn-start', turn: 1 }, { type: 'text', step: 0, text: 'ab' }, { type: 'text', step: 1, text: 'ab' }]);
  assert.deepEqual(tracker.consumeAll([message(6, 0, { text: 'canonical' })]).filter((u) => u.type === 'text'), [{ type: 'text', step: 0, text: 'canonical' }]);
  assert.equal(tracker.answer, 'canonical\n\nab');
});

test('Hermes deduplicates integer text frames across mux and history in either order', () => {
  for (const muxFirst of [true, false]) {
    const tracker = hermes();
    tracker.consumeAll(prefix());
    const frame = delta(3, 0, 'A');
    const first = tracker.consumeAll([frame], muxFirst ? { fromMux: true } : {});
    assert.deepEqual(first.filter(u => u.type === 'text').map(u => u.text), ['A']);
    assert.equal(tracker.lastSeq, muxFirst ? 2 : 3);
    const second = tracker.consumeAll([frame], muxFirst ? {} : { fromMux: true });
    assert.deepEqual(second.filter(u => u.type === 'text'), []);
    assert.equal(tracker.lastSeq, 3);
    assert.equal(tracker.answer, 'A');
  }
});

test('Hermes rejects stale attempt history after a newer mux attempt', () => {
  const tracker = hermes();
  tracker.consumeAll(prefix());
  const frame = (attemptId, attemptEpoch, streamIndex, text) => ({
    ...delta(2.5 + streamIndex / 100, 0, text),
    data: { ...delta(2, 0, text).data, attemptId, attemptEpoch, streamIndex },
  });
  tracker.consumeAll([frame('B', 2, 0, 'NEW')], { fromMux: true });
  assert.deepEqual(tracker.consumeAll([frame('A', 1, 0, 'OLD')]), []);
  tracker.consumeAll([frame('B', 2, 1, '!')], { fromMux: true });
  assert.equal(tracker.answer, 'NEW!');
  tracker.consumeAll([message(3, 0, { text: 'canonical' })]);
  assert.equal(tracker.answer, 'canonical');
});

test('Hermes failed durable turn retracts uncommitted drafts if mux end was lost', () => {
  for (const reason of ['error', 'completed']) {
    const tracker = hermes();
    tracker.consumeAll([...prefix(), message(3, 0, { text: 'committed' })]);
    const chunk = delta(3.5, 1, 'uncommitted');
    chunk.data.attemptId = 'attempt'; chunk.data.attemptEpoch = 1; chunk.data.streamIndex = 0;
    tracker.consumeAll([chunk], { fromMux: true });
    const updates = tracker.consumeAll([event('turn/end', 4, { reason: { kind: reason } })]);
    assert.deepEqual(updates.filter(u => u.type === 'text'), reason === 'error' ? [{ type: 'text', step: 1, text: '' }] : []);
    assert.equal(tracker.answer, reason === 'error' ? 'committed' : 'committed\n\nuncommitted');
    assert.equal(updates.at(-1).type, 'turn-end');
  }
});

test('Hermes long indexed stream replay is idempotent and restores out-of-order gaps', () => {
  const tracker = hermes();
  tracker.consumeAll(prefix());
  const frames = Array.from({ length: 4100 }, (_, i) => ({
    ...delta(2 + (i + 1) / (i + 2), 0, String(i % 10)),
    data: { ...delta(2, 0, String(i % 10)).data, attemptId: 'long', streamIndex: i },
  }));
  const missing = new Set([3, 999, 4097]);
  for (const frame of frames.filter((_, i) => !missing.has(i))) tracker.consumeAll([frame], { fromMux: true });
  const expected = frames.map(frame => frame.data.chunk.text).join('');
  assert.equal(tracker.answer.length, 4097);
  tracker.consumeAll(frames);
  assert.equal(tracker.answer, expected);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(tracker.consumeAll(frames), []);
    assert.equal(tracker.answer, expected);
  }
  assert.equal(tracker.lastSeq, 2);
});

test('Hermes canonical reasoning is opt-in, once per step and never duplicated by live/history reasoning frames', () => {
  const tracker = hermes();
  assert.deepEqual(tracker.consumeAll([delta(3.5, 0, 'live', 'reasoning-delta')], { live: true, fromMux: true }), []);
  const entries = [...prefix(), delta(3, 0, 'delta', 'reasoning-delta'), message(4, 0, { reasoning: 'canonical' }), message(5, 0, { reasoning: 'canonical' }), message(6, 1, { reasoning: 'next' })];
  const updates = tracker.consumeAll(entries, { live: true });
  assert.deepEqual(updates.filter((u) => u.type === 'reasoning'), [
    { type: 'reasoning', step: 0, text: 'canonical' }, { type: 'reasoning', step: 1, text: 'next' },
  ]);
  assert.deepEqual(tracker.consumeAll(entries, { live: true }), []);
  assert.equal(hermes({ reasoning: false }).consumeAll(entries, { live: true }).some((u) => u.type === 'reasoning'), false);
});

test('Hermes metrics deduplicate durable seq, not independent same-step messages, and isolate foreign turns and mux', () => {
  const tracker = hermes({ afterSeq: 10 });
  const targetPrefix = [event('turn/start', 11), event('user/message', 12, { source: { rpcId: promptRpcId } })];
  assert.deepEqual(tracker.consumeAll([message(9, 0, { usage: { inputTokens: 999, outputTokens: 999 } }),
    event('turn/start', 10), event('user/message', 10.5, { source: { rpcId: 'foreign' } }), message(11, 0)]), []);
  const own = message(13, 0, { usage: { inputTokens: 4, outputTokens: 1 } });
  const foreign = { ...message(14, 0, { usage: { inputTokens: 999, outputTokens: 999 } }), data: { ...message(14, 0).data, turn: 2 } };
  const updates = tracker.consumeAll([...targetPrefix, own, own, foreign, message(15, 0, { usage: { inputTokens: 6, outputTokens: 2 } })]);
  assert.deepEqual(metrics(updates).at(-1), { type: 'metrics', inputTokens: 10, outputTokens: 3, model: 'model-a', provider: 'provider-a' });
  assert.deepEqual(tracker.consumeAll([message(30, 1, { usage: { inputTokens: 999, outputTokens: 999 } }), event('turn/end', 31)], { live: true, fromMux: true }), []);
  assert.equal(tracker.lastSeq, 15);
  assert.equal(tracker.finished, false);
  assert.deepEqual(tracker.consumeAll([own, foreign]), []);
  assert.deepEqual(tracker.consumeAll([event('turn/end', 16, { turn: 2 })]), []);
  assert.equal(tracker.finished, false);
});

for (const missing of ['inputTokens', 'outputTokens', 'both']) {
  test(`Hermes hides incomplete ${missing} totals instead of displaying a partial round`, () => {
    const usage = { inputTokens: 20, outputTokens: 3 };
    if (missing === 'both') { delete usage.inputTokens; delete usage.outputTokens; }
    else delete usage[missing];
    const updates = hermes().consumeAll([...prefix(), message(3, 0, { usage: { inputTokens: 10, outputTokens: 2 } }), message(4, 1, { usage })]);
    const final = metrics(updates).at(-1);
    assert.equal('inputTokens' in final, missing !== 'inputTokens' && missing !== 'both');
    assert.equal('outputTokens' in final, missing !== 'outputTokens' && missing !== 'both');
    assert.equal(final.model, 'model-a');
    assert.equal('tokensPerSecond' in final, false);
    assert.equal('contextTokens' in final, false);
  });
}

for (const badUsage of [undefined, { inputTokens: -1, outputTokens: NaN }, { inputTokens: '10', outputTokens: Infinity }]) {
  test(`Hermes absent/invalid durable usage is hidden (${JSON.stringify(badUsage)})`, () => {
    assert.deepEqual(metrics(hermes().consumeAll([...prefix(), message(3, 0, { usage: badUsage })])), [{ type: 'metrics', model: 'model-a', provider: 'provider-a' }]);
  });
}

test('Hermes accepts real zero tokens and hides mixed model/provider labels without losing valid usage', () => {
  const updates = hermes().consumeAll([...prefix(), message(3, 0, { usage: { inputTokens: 0, outputTokens: 0 } }), message(4, 1, { usage: { inputTokens: 8, outputTokens: 2 }, modelSource: { kind: 'model', model: 'model-b', provider: 'provider-b' } })]);
  assert.deepEqual(metrics(updates), [
    { type: 'metrics', inputTokens: 0, outputTokens: 0, model: 'model-a', provider: 'provider-a' },
    { type: 'metrics', inputTokens: 8, outputTokens: 2 },
  ]);
});

for (const patch of [{ modelSource: { ...source, kind: 'tool' } }, { modelSource: undefined }]) {
  test(`Hermes untrusted source cannot produce model or token metrics (${JSON.stringify(patch)})`, () => {
    const untrusted = message(4, 1, { usage: { inputTokens: 500, outputTokens: 500 } });
    untrusted.data.message.source = patch.modelSource;
    const updates = hermes().consumeAll([...prefix(), message(3, 0, { usage: { inputTokens: 1, outputTokens: 1 } }), untrusted]);
    assert.deepEqual(metrics(updates).at(-1), { type: 'metrics' });
  });
}

test('Hermes missing step attribution or earlier observed step hides totals', () => {
  assert.deepEqual(metrics(hermes().consumeAll([...prefix(), message(3, undefined, { usage: { inputTokens: 1, outputTokens: 1 } })])).at(-1), { type: 'metrics' });
  assert.deepEqual(metrics(hermes().consumeAll([...prefix(), event('step/start', 3, { step: 0 }), message(4, 1, { usage: { inputTokens: 1, outputTokens: 1 } })])).at(-1), { type: 'metrics' });
});

for (const errorData of [
  { error: { name: 'ToolError', code: 'bad', reason: 'denied' } },
  { isError: true },
  { message: { isError: true } },
  { message: { content: [{ type: 'text', text: 'nested failure', isError: true }] } },
]) {
  test(`Hermes tool failures reflect result flags (${JSON.stringify(errorData)})`, () => {
    const resultMessage = { source: { kind: 'tool', callId: 'a' }, toolCallId: 'a', content: [{ type: 'text', text: 'failed' }], ...errorData.message };
    const updates = hermes().consumeAll([...prefix(), event('tool/call', 3, { name: 'read', callId: 'a' }), event('tool/result', 4, { ...errorData, message: resultMessage })]);
    const result = updates.at(-1);
    assert.equal(result.type, 'tool-result');
    assert.equal(result.callId, 'a');
    assert.equal(result.toolName, 'read');
    assert.equal(result.isError, true);
    assert.equal(typeof result.error, 'string');
  });
}

test('Hermes failed later step clears previously visible partial metrics at turn end', () => {
  const tracker = hermes();
  const updates = tracker.consumeAll([...prefix(), message(3, 0, { usage: { inputTokens: 10, outputTokens: 2 } }),
    event('step/start', 4, { step: 1 }), event('turn/end', 5, { reason: { kind: 'error' } })]);
  assert.deepEqual(metrics(updates), [
    { type: 'metrics', inputTokens: 10, outputTokens: 2, model: 'model-a', provider: 'provider-a' },
    { type: 'metrics' },
  ]);
});

test('Hermes result completion is only reported on result and never misattributes an unknown call', () => {
  const tracker = hermes();
  assert.deepEqual(tracker.consumeAll([...prefix(), event('tool/call', 3, { name: 'read', callId: 'a' })]).map((u) => u.type), ['turn-start', 'tool']);
  const updates = tracker.consumeAll([event('tool/result', 4, { message: { toolCallId: 'unknown', source: { kind: 'tool', callId: 'unknown' }, content: [{ type: 'text', text: 'ok' }] } })]);
  assert.deepEqual(updates, [{ type: 'tool-result', turn: 1, callId: 'unknown', text: 'ok', isError: false, error: null }]);
});

test('Hermes renders transient live text chunks as the draft without advancing the durable cursor', () => {
  const tracker = hermes();
  tracker.consumeAll(prefix());
  // DSH publishes live chunks with a fractional seq below the durable cursor.
  const live = tracker.consumeAll([delta(2.5, 0, 'H'), delta(2.6, 0, 'i')]);
  assert.deepEqual(live.filter((update) => update.type === 'text').at(-1), { type: 'text', step: 0, text: 'Hi' });
  // A repeated transient frame from the mux, or the same one again from history,
  // must not be rendered twice.
  assert.deepEqual(tracker.consumeAll([delta(2.5, 0, 'H')]), []);
  assert.deepEqual(tracker.consumeAll([delta(2.5, 0, 'H')], { fromMux: true }), []);
  // The durable cursor did not move, so the committed message still replaces
  // the draft text exactly once.
  assert.deepEqual(
    tracker.consumeAll([message(3, 0, { text: 'Hi there' })]).filter((update) => update.type === 'text'),
    [{ type: 'text', step: 0, text: 'Hi there' }],
  );
});

test('buffered mux drafts require durable ownership and retry frames are isolated', () => {
  const tracker = hermes();
  const frame = (attemptId, streamIndex, text, turn = 1) => event('assistant/chunk', 2.5 + streamIndex / 10, { turn, step: 0, attemptId, streamIndex, chunk: { type: 'text-delta', index: 0, text } });
  tracker.consumeAll([frame('foreign', 0, 'wrong', 2), frame('a', 0, 'old')], { fromMux: true });
  assert.equal(tracker.lastSeq, -1);
  assert.deepEqual(tracker.consumeAll(prefix()).filter((u) => u.type === 'text'), [{ type: 'text', step: 0, text: 'old' }]);
  assert.deepEqual(tracker.consumeAll([frame('a', 0, 'old')], { fromMux: true }), []);
  assert.equal(tracker.lastSeq, 2);
  tracker.consumeAll([event('assistant/stream-end', undefined, { step: 0, attemptId: 'a', outcome: 'failed' })], { fromMux: true });
  assert.deepEqual(tracker.consumeAll([frame('b', 0, 'new')], { fromMux: true }), [{ type: 'text', step: 0, text: 'new' }]);
  assert.deepEqual(tracker.consumeAll([frame('a', 1, 'late')], { fromMux: true }), []);
  tracker.consumeAll([message(3, 0, { text: 'canonical' })]);
  assert.equal(tracker.answer, 'canonical');
  assert.deepEqual(tracker.consumeAll([frame('b', 1, 'late')], { fromMux: true }), []);
});

test('ask delivers two mux updates before turn completion, including frames before prompt returns', async () => {
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  let history = [], send, finish;
  const queue = [];
  const mux = (_request, signal) => {
    let waiting;
    send = (value) => { if (waiting) { const resolve = waiting; waiting = null; resolve({ value, done: false }); } else queue.push(value); };
    finish = () => { if (waiting) { const resolve = waiting; waiting = null; resolve({ done: true }); } };
    signal.addEventListener('abort', finish, { once: true });
    return { [Symbol.asyncIterator]() { return this; }, next() { return queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((resolve) => { waiting = resolve; }); }, return() { finish(); return Promise.resolve({ done: true }); } };
  };
  const emit = (e) => send({ type: 'server-request', rpcId: 'frame', method: 'session/event', payload: { type: 'session/event', sessionId: 'session', event: e } });
  const client = new HarnessClient({ apiProxy: {
    host: { describe: ({ rpcId }) => success(rpcId, {}) },
    workspace: { list: ({ rpcId }) => success(rpcId, { items: [], archivedSessionIds: [] }) },
    events: { mux },
    sessions: {
      history: ({ rpcId }) => success(rpcId, { events: history.map((e) => ({ event: e })) }),
      prompt: async ({ rpcId }) => {
        history = [event('turn/start', 1), event('user/message', 2, { source: { rpcId } })];
        emit(event('assistant/chunk', 2.5, { step: 0, attemptId: 'a', streamIndex: 0, chunk: { type: 'text-delta', index: 0, text: 'H' } }));
        await new Promise((resolve) => setTimeout(resolve, 400));
        setTimeout(() => emit(event('assistant/chunk', 2.6, { step: 0, attemptId: 'a', streamIndex: 1, chunk: { type: 'text-delta', index: 0, text: 'i' } })), 900);
        return success(rpcId, {});
      },
    },
  }, workspace: 'C:\\\\fixture' });
  const updates = [];
  const pending = client.ask('session', 'hello', { hermesCard: true, progressMode: 'all', onUpdate: (update) => updates.push(update), timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.deepEqual(updates.filter((u) => u.type === 'text').map((u) => u.text), ['H', 'Hi']);
  history.push(message(3, 0, { text: 'Hi' }), event('turn/end', 4, { reason: { kind: 'completed' } }));
  assert.equal(await pending, 'Hi');
});

test('HarnessClient forwards hermesCard strict opt-in through ask options without altering the prompt wire', async () => {
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  for (const hermesCard of [true, 'true']) {
    let history = [];
    const client = new HarnessClient({ apiProxy: {
      host: { describe: ({ rpcId }) => success(rpcId, {}) },
      workspace: { list: ({ rpcId }) => success(rpcId, { items: [], archivedSessionIds: [] }) },
      events: { mux(_request, signal) {
        return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ done: true }), { once: true })); }, return() { return Promise.resolve({ done: true }); } };
      } },
      sessions: {
        history: ({ rpcId }) => success(rpcId, { events: history.map((event) => ({ event })) }),
        prompt: ({ rpcId, payload }) => {
          assert.equal('hermesCard' in payload, false);
          history = [event('turn/start', 1), event('user/message', 2, { source: { rpcId } }), message(3, 0, { usage: { inputTokens: 5, outputTokens: 2 } }), event('turn/end', 4, { reason: { kind: 'completed' } })];
          return success(rpcId, {});
        },
      },
    }, workspace: 'C:\\fixture' });
    const updates = [];
    assert.equal(await client.ask('session', 'hello', { hermesCard, reasoning: true, progressMode: 'all', onUpdate: (update) => updates.push(update), timeoutMs: 3000 }), 'answer');
    assert.equal(updates.some((update) => update.type === 'metrics'), hermesCard === true);
    assert.equal(updates.some((update) => update.type === 'turn-start'), hermesCard === true);
  }
});
