import assert from 'node:assert/strict';
import test from 'node:test';
import { modernHarnessApi } from '../../../plugin-src/host/modern-harness-api.mjs';
import { terminalDisplaySnapshot } from '../../../plugin-src/host/terminal-display-snapshot.mjs';

const route = { provider: 'provider', model: 'model' };
const usage = { inputTokens: 1200, outputTokens: 32, cacheReadTokens: 900 };
function fixture(options = {}) {
  const calls = [], listeners = new Map();
  const events = [];
  const append = (type, data) => {
    const event = { type, seq: events.length, time: events.length, data };
    events.push(event);
    return event;
  };
  append('turn/start', { turn: 1 });
  append('step/start', { turn: 1, step: 0 });
  append('request/header', { header: { config: { ...route } } });
  append('request/context', { ...route, contextWindow: 100000 });
  append('assistant/message', { turn: 1, step: 0, message: {
    role: 'assistant', source: { kind: 'model', ...route }, content: [{ type: 'text', text: '正文' }],
  }, usage: { ...usage }, stream: [] });
  append('step/end', { turn: 1, step: 0 });
  append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const session = {
    id: 'session',
    get seq() { return events.length; },
    eventAt(seq) { return events[seq]; },
    snapshotEvents() { return events; },
    requestHeader() { return events.findLast(e => e.type === 'request/header')?.data.header; },
    requestContext() { return events.findLast(e => e.type === 'request/context')?.data; },
  };
  const tokenMeter = { contextPressure(value) {
    calls.push('pressure');
    assert.equal(value, session);
    return options.pressure ?? { pressureTokens: 1234, contextWindow: 100000 };
  }, measure() { assert.fail('must not estimate'); }, estimateMessage() { assert.fail('must not estimate'); } };
  const services = {
    tokenMeter,
    sessionQuery: { async inspectSession(id, read, signal) {
      calls.push('inspect');
      assert.equal(id, 'session');
      assert.equal(signal, options.signal);
      if (options.inspectFailure) throw new Error('optional unavailable');
      const result = read(session);
      assert.equal(result?.then, undefined, 'getter must be synchronous');
      if (options.afterRead) options.afterRead({ append, emit, session });
      return result;
    } },
  };
  if (options.noQuery) delete services.sessionQuery;
  if (options.noMeter) delete services.tokenMeter;
  const records = () => (options.records ?? events).map(event => ({ type: 'event', event: structuredClone(event) }));
  const ctx = {
    root: {}, get: key => services[key],
    typertGateway: {
      async *stream(request) {
        calls.push('rpc/follow');
        if (options.rpcFailure) throw Object.assign(new Error('denied'), { failure: { code: 'forbidden', message: 'denied' } });
        yield { type: 'snapshot', cursor: options.cursor ?? events.length - 1,
          records: records(), hasMore: true, projections: { marker: 'preserved' } };
      },
      async invoke(request) {
        calls.push('rpc/page');
        assert.equal(request.method, 'page');
        if (options.rpcFailure) throw new Error('denied');
        return { records: records(), hasMore: false };
      },
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  function emit(event) { listeners.get('session/event')?.(session, event); }
  const api = modernHarnessApi(ctx);
  const history = payload => api.sessions.history({ rpcId: 'history', payload: { sessionId: 'session', terminalDisplay: true, ...payload } }, options.signal);
  return { events, append, session, services, calls, emit, api, history };
}
const expected = { asOfSeq: 6, turn: 1, step: 0, messageSeq: 4, ...route, contextTokens: 1234, contextWindow: 100000 };
function direct(f) {
  return terminalDisplaySnapshot(f.session, f.services.tokenMeter,
    { sessionId: 'session', asOfSeq: f.events.length - 1, entries: f.events.map(event => ({ event })) });
}
function omitted(result) {
  assert.equal(result.result.ok, true);
  assert.equal(Object.hasOwn(result.result.value, 'terminalDisplay'), false);
  assert.ok(result.result.value.events.some(entry => entry.event.type === 'assistant/message'));
}

test('cold latest follow: RPC precedes synchronous query and detached pressure snapshot', async () => {
  const f = fixture();
  const before = JSON.stringify(f.events);
  const result = await f.history();
  assert.deepEqual(result.result.value.terminalDisplay, expected);
  assert.deepEqual(f.calls, ['rpc/follow', 'inspect', 'pressure']);
  assert.deepEqual(result.result.value.projections, { marker: 'preserved' });
  assert.equal(JSON.stringify(f.events), before);
  assert.deepEqual(Object.keys(result.result.value.events[4].event.data).sort(), ['message', 'step', 'stream', 'turn', 'usage']);
  assert.ok(Object.isFrozen(result.result.value.terminalDisplay));
  f.events[4].data.message.source.model = 'changed';
  assert.equal(result.result.value.terminalDisplay.model, 'model');
});

test('latest cached page has snapshot; beforeSeq (including zero) never inspects', async () => {
  const f = fixture();
  await f.history();
  f.calls.length = 0;
  assert.deepEqual((await f.history()).result.value.terminalDisplay, expected);
  assert.deepEqual(f.calls, ['rpc/page', 'inspect', 'pressure']);
  for (const beforeSeq of [0, 4]) {
    f.calls.length = 0;
    omitted(await f.history({ beforeSeq }));
    assert.deepEqual(f.calls, ['rpc/page']);
  }
});

for (const terminalDisplay of [undefined, false, 'true', 1, null]) {
  test(`history has zero optional service reads unless explicit true: ${String(terminalDisplay)}`, async () => {
    const f = fixture();
    let reads = 0;
    for (const key of ['tokenMeter', 'sessionQuery']) {
      Object.defineProperty(f.services, key, { get() { reads++; throw new Error('must not read optional service'); } });
    }
    // Omit the property entirely for the default legacy request.
    const payload = { sessionId: 'session', ...(terminalDisplay === undefined ? {} : { terminalDisplay }) };
    omitted(await f.api.sessions.history({ rpcId: 'legacy', payload }));
    omitted(await f.api.sessions.history({ rpcId: 'legacy-page', payload }));
    assert.deepEqual(f.calls, ['rpc/follow', 'rpc/page']);
    assert.equal(reads, 0);
  });
}

test('authorization failure never triggers local session or meter access', async () => {
  const f = fixture({ rpcFailure: true });
  const result = await f.history();
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error.code, 'forbidden');
  assert.deepEqual(f.calls, ['rpc/follow']);
});

for (const options of [{ noMeter: true }, { noQuery: true }, { inspectFailure: true }]) {
  test(`optional services fail closed without losing history ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    omitted(await f.history());
    assert.ok(!f.calls.includes('pressure'));
  });
}

test('optional live cache fallback only uses exact terminal cut', async () => {
  const f = fixture({ noQuery: true });
  f.emit(f.events.at(-1));
  assert.deepEqual((await f.history()).result.value.terminalDisplay, expected);
  f.append('turn/start', { turn: 2 }); // batch tail not published yet
  omitted(await f.history());
});

test('failed inspectSession never bypasses failure using live cache fallback', async () => {
  const f = fixture({ inspectFailure: true });
  f.emit(f.events.at(-1));
  omitted(await f.history());
  assert.ok(!f.calls.includes('pressure'));
});

for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
  test(`non-completed terminal ${kind} is omitted`, async () => {
    const f = fixture();
    f.events[6].data.reason.kind = kind;
    omitted(await f.history());
    assert.ok(!f.calls.includes('pressure'));
  });
}

for (const [name, mutate] of [
  ['interrupted assistant', f => { f.events[4].data.interrupted = true; }],
  ['missing usage', f => { delete f.events[4].data.usage; }],
  ['non-model source', f => { f.events[4].data.message.source.kind = 'user'; }],
  ['wrong source route', f => { f.events[4].data.message.source.model = 'other'; }],
  ['wrong request route', f => { f.events[2].data.header.config.provider = 'other'; }],
  ['wrong context route', f => { f.events[3].data.model = 'other'; }],
  ['zero capacity', f => { f.events[3].data.contextWindow = 0; }],
  ['negative usage', f => { f.events[4].data.usage.outputTokens = -1; }],
  ['NaN usage', f => { f.events[4].data.usage.inputTokens = NaN; }],
  ['step end mismatch', f => { f.events[5].data.step = 9; }],
  ['step start mismatch', f => { f.events[1].data.step = 9; }],
  ['message turn mismatch', f => { f.events[4].data.turn = 9; }],
  ['turn start mismatch', f => { f.events[0].data.turn = 9; }],
  ['failed stream finish', f => { f.events[4].data.stream = [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }]; }],
]) {
  test(`${name} cannot enrich old assistant`, async () => {
    const f = fixture(); mutate(f);
    omitted(await f.history());
    assert.ok(!f.calls.includes('pressure'));
  });
}

for (const type of ['request/header', 'request/context', 'step/start', 'assistant/attempt', 'turn/start']) {
  test(`later ${type} in committed batch invalidates old cursor before notification`, async () => {
    const f = fixture({ cursor: 6 });
    f.emit(f.events[6]);
    f.append(type, { turn: 2, step: 1 });
    omitted(await f.history());
    assert.ok(!f.calls.includes('pressure'));
  });
  test(`later ${type} at latest cursor invalidates old pressure`, async () => {
    const f = fixture(); f.append(type, { turn: 2, step: 1 });
    omitted(await f.history());
  });
}

for (const pressure of [ {}, { pressureTokens: 0, contextWindow: 100000 },
  { pressureTokens: NaN, contextWindow: 100000 }, { pressureTokens: 1234, contextWindow: -1 },
  { pressureTokens: 1234, contextWindow: 200000 } ]) {
  test(`invalid pressure/capacity omitted ${JSON.stringify(pressure)}`, async () => {
    omitted(await fixture({ pressure }).history());
  });
}

test('message must appear on successful current history page', async () => {
  const f = fixture({ records: [] });
  const result = await f.history();
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value.events, []);
  assert.equal(result.result.value.terminalDisplay, undefined);
  assert.ok(!f.calls.includes('pressure'));
});

test('inspection result cannot cross a newer cursor published while awaiting', async () => {
  const f = fixture({ afterRead({ append, emit }) { emit(append('turn/start', { turn: 2 })); } });
  omitted(await f.history());
});

test('pressure failures are isolated; no estimate fallback', async () => {
  const f = fixture();
  f.services.tokenMeter.contextPressure = () => { throw new Error('meter unavailable'); };
  omitted(await f.history());
});

test('getter rejects incomplete logs, wrong identity and fractional cut', () => {
  const f = fixture();
  assert.deepEqual(direct(f), expected);
  const read = overrides => terminalDisplaySnapshot(f.session, f.services.tokenMeter,
    { sessionId: 'session', asOfSeq: 6, entries: f.events.map(event => ({ event })), ...overrides });
  assert.equal(read({ sessionId: 'other' }), undefined);
  assert.equal(read({ asOfSeq: 6.5 }), undefined);
  f.events[5] = undefined;
  assert.equal(direct(f), undefined);
});

test('multi-step usage is not cumulative input; only latest completed step is represented', async () => {
  const f = fixture();
  f.events.splice(5); // remove terminal end
  f.append('step/end', { turn: 1, step: 0 });
  f.append('step/start', { turn: 1, step: 1 });
  f.append('assistant/message', { ...structuredClone(f.events[4].data), step: 1, usage: { inputTokens: 42, outputTokens: 1 } });
  f.append('step/end', { turn: 1, step: 1 });
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual((await f.history()).result.value.terminalDisplay,
    { ...expected, asOfSeq: 9, step: 1, messageSeq: 7 });
});
