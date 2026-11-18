import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DshHfcAdapter, HfcWorker, defaultHfcWorkerPath } from '../../../src/channels/feishu/hfc/adapter.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '7' };
const receipt = { messageId: 'message', providerMessageIds: ['message'] };
function result(disposition = 'card', extra = {}) {
  return { accepted: true, card: { schema: '2.0', body: { elements: [] } }, disposition, segments: [], summary: {}, ...extra };
}
function setup({ events, budgets, nativeResult = receipt, patchError } = {}) {
  const calls = []; let index = 0;
  const worker = { async start() {}, async reset() { calls.push(['reset']); }, async close() { calls.push(['close']); },
    async event(event) { calls.push(['event', event]); const r = events?.(event, index++); if (r instanceof Error) throw r; return r ?? result(); } };
  const sink = { async create(card) { calls.push(['create', card]); return receipt; },
    async patch(card) { calls.push(['patch', card]); if (patchError) throw patchError; return receipt; },
    async native(text) { calls.push(['native', text]); return nativeResult; } };
  return { adapter: new DshHfcAdapter({ worker, route, sink, budgets, minRenderIntervalMs: 0 }), worker, calls };
}
const err = (code) => Object.assign(new Error(code), { code });

test('Python is explicitly required; asset path stays inside candidate', () => {
  assert.throws(() => new HfcWorker(), /hfc-python-required/);
  assert.match(defaultHfcWorkerPath().replaceAll('\\', '/'), /candidate\/assets\/hfc\/worker\.py$/);
});

test('short card uses one create and patches; finish is idempotent', async () => {
  const { adapter, calls } = setup();
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'text', text: 'first', step: 0, turn: 7 });
    await adapter.onUpdate({ type: 'text', text: 'first edited', step: 0, turn: 7 });
    await adapter.finish({ text: 'complete' }); await adapter.finish({ text: 'complete' });
    assert.equal(calls.filter(([op]) => op === 'create').length, 1);
    assert.equal(calls.filter(([op]) => op === 'native').length, 0);
    assert.equal(calls.filter(([op]) => op === 'reset').length, 1);
    assert.equal(adapter.finished, true);
  } finally { await adapter.close(); }
});

test('deferred does not send body; terminal native uses exact DSH text not upstream empty primary_text', async () => {
  const full = 'head\n' + '汉字 abc '.repeat(20_000) + '\nTAIL-SENTINEL';
  const { adapter, calls } = setup({ events: (e) => result(e.event === 'message.started' ? 'card' : e.event === 'message.completed' ? 'native' : 'deferred_native', { primary_text: '' }) });
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'text', text: 'draft', step: 0 });
    assert.equal(calls.filter(([op]) => op === 'native').length, 0);
    await adapter.finish({ text: full }); await adapter.finish({ text: full });
    assert.deepEqual(calls.filter(([op]) => op === 'native').map(([, text]) => text), [full]);
    assert.equal(adapter.finished, true);
  } finally { await adapter.close(); }
});

test('partial/unknown native receipt does not finish and cannot retry whole body', async () => {
  for (const bad of [null, { providerMessageIds: ['only-first'], complete: false }, { messageId: 'x', status: 'unknown' }]) {
    const { adapter, calls } = setup({ events: (e) => result(e.event === 'message.completed' ? 'native' : 'card'), nativeResult: bad });
    try {
      await adapter.start(); await assert.rejects(adapter.finish({ text: 'all text' }), /native-unconfirmed/);
      assert.equal(adapter.finished, false);
      await assert.rejects(adapter.finish({ text: 'all text' }), /terminal-already-attempted/);
      assert.equal(calls.filter(([op]) => op === 'native').length, 1);
    } finally { await adapter.close(); }
  }
});

test('patch failure never creates another card or native fallback', async () => {
  const { adapter, calls } = setup({ patchError: err('patch-unknown') });
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'text', text: 'x' });
    await new Promise(resolve => setTimeout(resolve, 1)); await adapter.publishTail;
    assert.equal(adapter.publishError?.message, 'patch-unknown');
    await assert.rejects(adapter.finish({ text: 'final' }), /patch-unknown/);
    assert.equal(calls.filter(([op]) => op === 'create').length, 1);
    assert.equal(calls.filter(([op]) => op === 'native').length, 0);
  } finally { await adapter.close(); }
});

test('worker failure and JS input budget keep full final for same-owner native fallback', async () => {
  for (const settings of [
    { events: (e) => e.event === 'answer.delta' ? err('worker-timeout') : result() },
    { budgets: { inputBytes: 100 } },
    { budgets: { retainedBytes: 900 } },
    { budgets: { replayEvents: 1 } },
  ]) {
    const { adapter, calls } = setup(settings);
    try {
      await adapter.start();
      if (settings.budgets?.replayEvents) {
        await adapter.onUpdate({ type: 'text', text: 'first', step: 0 });
        await assert.rejects(adapter.onUpdate({ type: 'text', text: 'changed', step: 0 }), /adapter-replay-budget/);
      } else await assert.rejects(adapter.onUpdate({ type: 'text', text: 'x'.repeat(1_000), step: 0 }));
      const final = 'full final\n' + 'z'.repeat(300_000) + 'END';
      await adapter.finish({ text: final });
      assert.deepEqual(calls.filter(([op]) => op === 'native').map(([, text]) => text), [final]);
      assert.equal(adapter.finished, true);
    } finally { await adapter.close(); }
  }
});

test('bounded queue fails before retaining excess queued drafts', async () => {
  let release;
  const { adapter, worker } = setup({ budgets: { queue: 1 } });
  await adapter.start();
  const original = worker.event;
  worker.event = (event) => event.event === 'answer.delta' ? new Promise((done) => { release = () => done(result()); }) : original(event);
  const first = adapter.onUpdate({ type: 'text', text: 'first', step: 0 });
  await Promise.resolve();
  await assert.rejects(adapter.onUpdate({ type: 'text', text: 'excess', step: 1 }), /adapter-queue-budget/);
  release(); await first; assert.equal(adapter.textRecords.size, 1);
  await adapter.close();
});

test('draft patches coalesce at 500ms without publishing unsent bindings; terminal always flushes', async () => {
  const { adapter, calls } = setup(); adapter.minRenderIntervalMs = 500;
  try {
    await adapter.start();
    const first = await adapter.onUpdate({ type: 'text', text: 'one', step: 0 });
    await adapter.onUpdate({ type: 'reasoning', text: 'thinking', step: 0 });
    await adapter.onUpdate({ type: 'text', text: 'two', step: 0 });
    assert.equal(first.coalesced, true);
    assert.equal(calls.filter(([op]) => op === 'patch').length, 0);
    await adapter.finish({ text: 'full final' });
    assert.equal(calls.filter(([op]) => op === 'patch').length, 1);
  } finally { await adapter.close(); }
});

test('segmented response explicitly fails instead of silently dropping continuation cards', async () => {
  const { adapter } = setup({ events: () => result('segmented', { segments: [{ a: 1 }] }) });
  try { await assert.rejects(adapter.start(), /unsupported-disposition/); } finally { await adapter.close(); }
});

function fakeSpawn(mode) {
  let child;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killCount = 0; child.kill = () => { child.killCount++; queueMicrotask(() => child.emit('close', 1)); return true; };
    child.stdin.on('data', () => {
      if (mode === 'malformed') child.stdout.write('not-json\n');
      if (mode === 'oversized') child.stdout.write('x'.repeat(200));
      if (mode === 'eof') child.stdout.end();
      if (mode === 'exit') child.emit('exit', 1);
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return { spawnProcess, get child() { return child; } };
}

test('worker timeout/malformed/output-budget/EOF/exit poison process and close waits for exit', async () => {
  for (const mode of ['hang', 'malformed', 'oversized', 'eof', 'exit']) {
    const fake = fakeSpawn(mode);
    const worker = new HfcWorker({ python: 'python', workerPath: 'fake', timeoutMs: 20, maxOutputBytes: 100, spawnProcess: fake.spawnProcess });
    await assert.rejects(worker.reset(), /worker-/);
    assert.ok(fake.child.killCount > 0);
    await assert.rejects(worker.reset(), /worker-/);
    await worker.close(); assert.equal(worker.child, null);
  }
});

test('vendored sources retain exact hash/version provenance', () => {
  const root = new URL('../../../assets/hfc/upstream/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', root), 'utf8'));
  assert.equal(manifest.version, '5.0.25');
  assert.ok(Object.keys(manifest.sha256).length >= 20);
  for (const [name, hash] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex'), hash, name);
  assert.match(readFileSync(new URL('LICENSE', root), 'utf8'), /MIT License/);
});

function realFixture(t, { signal } = {}) {
  const worker = new HfcWorker({ python }); const cards = []; let breakPatch = false;
  const adapter = new DshHfcAdapter({ worker, route, signal, sink: {
    async create(card) { cards.push(card); return receipt; },
    async patch(card) { if (breakPatch) throw err('sink-unknown'); cards.push(card); return receipt; },
    async createInteraction(id, card) { cards.push(card); return { messageId: `rail:${id}` }; },
    async patchInteraction(id, messageId, card) { if (breakPatch) throw err('sink-unknown'); cards.push(card); return { messageId }; },
    async native() { return receipt; },
  } });
  t.after(() => adapter.close());
  return { adapter, cards, failPatch() { breakPatch = true; }, button() {
    const node = findNode(cards.at(-1), (n) => n.value?.hfc_action === 'interaction.select');
    assert.ok(node, 'real upstream button'); return { actor: route, messageId: `rail:${node.value.interaction_id}`, value: node.value };
  } };
}
function approval(respond) {
  return { kind: 'approval', interactionId: 'fixture-approval', rpcId: 'rpc', sessionId: route.sessionId,
    payload: { type: 'approval/requested', sessionId: route.sessionId, approvalId: 'fixture-approval', toolName: 'read_file', callId: 'call', reason: 'read only' },
    toolCall: { callId: 'call', name: 'read_file', arguments: '{"path":"fixture.txt"}' }, respond };
}
function question(respond) {
  return { kind: 'question', interactionId: 'fixture-question', rpcId: 'rpc', sessionId: route.sessionId,
    payload: { type: 'question/requested', sessionId: route.sessionId, questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }, respond };
}

test('real upstream approval calls original respond once; failed RPC remains retryable', { skip: !python }, async (t) => {
  const f = realFixture(t); let attempts = 0; const responses = [];
  await f.adapter.start(); await f.adapter.onInteraction(approval(async (response) => {
    attempts++; if (attempts === 1) throw err('host-unavailable'); responses.push(response); return { accepted: true };
  }));
  const action = f.button();
  assert.equal((await f.adapter.onAction({ ...action, actor: { ...route, senderId: 'forged' } })).accepted, false);
  assert.equal((await f.adapter.onAction(action)).accepted, false);
  assert.equal(attempts, 1); assert.equal(responses.length, 0);
  assert.equal((await f.adapter.onAction(action)).accepted, true);
  assert.equal((await f.adapter.onAction(action)).accepted, false);
  assert.equal(attempts, 2);
  assert.deepEqual(responses, [{ ok: true, value: { sessionId: route.sessionId, approvalId: 'fixture-approval', outcome: 'allowed-once' } }]);
});

test('real approval external resolve and concurrent double-click do not resubmit', { skip: !python }, async (t) => {
  const f = realFixture(t); let calls = 0;
  await f.adapter.start(); await f.adapter.onInteraction(approval(async () => { calls++; return { accepted: true }; })); const action = f.button();
  await assert.rejects(f.adapter.finish({ text: 'cannot finish' }), /interaction-still-pending/);
  await f.adapter.onInteractionResolved({ kind: 'approval', interactionId: 'fixture-approval', sessionId: route.sessionId, outcome: 'rejected' });
  assert.equal((await f.adapter.onAction(action)).accepted, false); assert.equal(calls, 0);
  await f.adapter.finish({ text: 'done' });
  const g = realFixture(t); let release; let entered;
  const ready = new Promise((done) => { entered = done; }); const gate = new Promise((done) => { release = done; });
  await g.adapter.start(); await g.adapter.onInteraction(approval(async () => { calls++; entered(); await gate; return { accepted: true }; })); const click = g.button();
  const first = g.adapter.onAction(click); await ready; const second = g.adapter.onAction(click); release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(results.filter((r) => r.accepted).length, 1);
});

test('real question commit-before-patch failure and abort invalidate stale buttons', { skip: !python }, async (t) => {
  const f = realFixture(t); let calls = 0;
  await f.adapter.start(); await f.adapter.onInteraction(question(async () => { calls++; return { accepted: true }; })); const action = f.button();
  f.failPatch(); await assert.rejects(f.adapter.onAction(action), /sink-unknown/);
  assert.equal((await f.adapter.onAction(action)).accepted, false); assert.equal(calls, 1);
  const abort = new AbortController(); const g = realFixture(t, { signal: abort.signal });
  await g.adapter.start(); await g.adapter.onInteraction(question(async () => { calls++; return { accepted: true }; })); const old = g.button();
  abort.abort(); assert.equal((await g.adapter.onAction(old)).accepted, false); assert.equal(calls, 1);
});

function findNode(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) { const found = findNode(child, predicate); if (found) return found; }
  return null;
}

test('real pinned worker: long text native and empty-value trusted form once only', { skip: !python }, async () => {
  const worker = new HfcWorker({ python }); const cards = []; const natives = []; const responses = [];
  const adapter = new DshHfcAdapter({ worker, route, sink: {
    async create(card) { cards.push(card); return receipt; }, async patch(card) { cards.push(card); return receipt; },
    async createInteraction(id, card) { cards.push(card); return { messageId: `rail:${id}` }; },
    async patchInteraction(id, messageId, card) { cards.push(card); return { messageId }; },
    async native(text) { natives.push(text); return receipt; },
  } });
  try {
    await adapter.start();
    await adapter.onInteraction({ kind: 'question', rpcId: 'rpc1', interactionId: 'iq', sessionId: route.sessionId,
      payload: { sessionId: route.sessionId, questions: [{ id: 'q', question: 'Choose', multiSelect: true, options: [{ label: 'a,b' }, { label: 'c、d' }] }] },
      async respond(value) { responses.push(value); return { accepted: true }; },
    });
    const form = findNode(cards.at(-1), (n) => typeof n.name === 'string' && n.name.startsWith('hfc_confirm_'));
    assert.ok(form, 'upstream native multi-select form');
    for (const wrong of [{ ...route, senderId: 'other' }, { ...route, turnId: 'old' }]) {
      assert.equal((await adapter.onAction({ actor: wrong, value: {}, name: form.name, formValue: { hfc_multi: ['a,b'] } })).accepted, false);
    }
    assert.equal((await adapter.onAction({ actor: route, value: { profile_id: 'wrong' }, name: form.name, formValue: { hfc_multi: ['a,b'] } })).accepted, false);
    const action = { actor: route, messageId: 'rail:iq:q:0', value: {}, name: form.name, formValue: { hfc_multi: ['a,b', 'c、d'], hfc_other: 'custom' } };
    assert.equal((await adapter.onAction(action)).accepted, true);
    assert.equal((await adapter.onAction(action)).accepted, false);
    assert.deepEqual(responses[0].value.answer.answers, [{ id: 'q', selected: ['a,b', 'c、d'], custom: 'custom' }]);
    assert.equal(responses.length, 1);
    const text = 'BEGIN\n' + '汉abc字 '.repeat(10_000) + '\nEND';
    const final = await adapter.finish({ text });
    assert.equal(final.disposition, 'native'); assert.deepEqual(natives, [text]); assert.equal(cards.length > 0, true);
  } finally { await adapter.close(); }
  assert.equal(worker.child, null);
});
