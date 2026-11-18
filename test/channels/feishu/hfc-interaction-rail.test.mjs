import test from 'node:test';
import assert from 'node:assert/strict';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'bot', sessionId: 'session', chatId: 'chat', senderId: 'user', turnId: '73' };
const find = (value, predicate) => {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) { const result = find(child, predicate); if (result) return result; }
  return null;
};
const activeControl = card => find(card, n => n.value?.hfc_action || /^hfc_(other|confirm)_/.test(n.name ?? ''));
function fixture(t, options = {}) {
  const writes = [], cards = new Map(), attempts = [];
  let seq = 0;
  const receipt = messageId => ({ messageId, providerMessageIds: [messageId] });
  const save = (kind, id, card) => {
    const schema = card.schema ?? '1.0';
    if (cards.has(id)) assert.equal(schema, cards.get(id).schema ?? '1.0', 'provider rejects schema switch on same message');
    cards.set(id, structuredClone(card)); writes.push({ kind, id, card: structuredClone(card) }); return receipt(id);
  };
  const sink = {
    async create(card) { attempts.push('create'); return save('create', 'main', card); },
    async patch(card) { attempts.push('patch'); return save('patch', 'main', card); },
    async createInteraction(displayId, card) {
      attempts.push('createInteraction');
      if (options.unknownCreate) return { status: 'unknown' };
      if (options.createGate) { options.createGate.entered(); await options.createGate.promise; }
      if (options.reuseMain) return receipt('main');
      return save('createInteraction', `rail-${++seq}`, card);
    },
    async patchInteraction(displayId, messageId, card) {
      attempts.push('patchInteraction');
      if (options.unknownPatch) return { messageId, status: 'unknown' };
      return save('patchInteraction', messageId, card);
    },
    async native() { assert.fail('no native retry'); },
  };
  const adapter = new DshHfcAdapter({ worker: new HfcWorker({ python }), route, sink, minPatchIntervalMs: 0,
    minRenderIntervalMs: 0, ...options.adapter });
  t.after(() => adapter.close());
  return { adapter, cards, writes, attempts, current() {
    const rail = writes.findLast(w => w.kind.endsWith('Interaction'));
    assert.ok(rail, 'standalone interaction exists');
    return rail;
  }, action() {
    const rail = this.current();
    const button = find(rail.card, n => n.value?.hfc_action === 'interaction.select');
    assert.ok(button, 'real upstream choice button');
    return { actor: route, messageId: rail.id, value: button.value };
  } };
}
const question = (respond, questions = [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }]) => ({
  kind: 'question', interactionId: 'question', rpcId: 'rpc', sessionId: route.sessionId,
  payload: { sessionId: route.sessionId, questions }, respond,
});

test('real Python standalone rail keeps main schema2, question schema1, sequential per-question receipts and terminal controls', { skip: !python }, async t => {
  const f = fixture(t), responses = [];
  await f.adapter.start();
  await f.adapter.onInteraction(question(async r => { responses.push(r); return { accepted: true }; }, [
    { id: 'first', question: 'First', options: [{ label: 'A' }] },
    { id: 'second', question: 'Second', options: [{ label: 'B' }] },
  ]));
  assert.equal(f.cards.get('main').schema, '2.0'); assert.equal(activeControl(f.cards.get('main')), null);
  const first = f.action(); assert.equal(f.cards.get(first.messageId).schema, undefined);
  assert.equal((await f.adapter.onAction({ ...first, messageId: 'main' })).accepted, false, 'same-owner main cannot carry rail token');
  assert.equal((await f.adapter.onAction(first)).accepted, true); assert.equal(responses.length, 0);
  assert.equal(activeControl(f.cards.get(first.messageId)), null, 'resolved first rail has no controls');
  const second = f.action(); assert.notEqual(second.messageId, first.messageId);
  assert.equal((await f.adapter.onAction({ ...second, messageId: first.messageId })).accepted, false, 'token cannot move between same-owner rails');
  assert.equal((await f.adapter.onAction(first)).accepted, false, 'stale replay rejected');
  assert.equal((await f.adapter.onAction(second)).accepted, true);
  assert.deepEqual(responses[0].value.answer.answers, [{ id: 'first', selected: ['A'] }, { id: 'second', selected: ['B'] }]);
  await f.adapter.finish({ text: 'done' });
  assert.equal(f.cards.get('main').schema, '2.0'); assert.equal(f.cards.get('main').header, undefined);
  assert.equal(activeControl(f.cards.get(second.messageId)), null);
  assert.equal(f.writes.filter(w => w.kind === 'create').length, 1);
  assert.equal(f.writes.filter(w => w.kind === 'createInteraction').length, 2);
});

for (const outcome of ['external', 'expired', 'failed', 'abort']) {
  test(`real Python ${outcome} rail revokes callbacks; live terminal removes visible controls`, { skip: !python }, async t => {
    const abort = new AbortController(), responses = [];
    const f = fixture(t, { adapter: { signal: abort.signal, interactionTimeoutMs: outcome === 'expired' ? 1 : 300000 } });
    await f.adapter.start();
    await f.adapter.onInteraction(question(async r => { responses.push(r); return { accepted: true }; }));
    const action = f.action(), before = f.attempts.length;
    if (outcome === 'abort') abort.abort();
    else if (outcome === 'expired') await new Promise(resolve => setTimeout(resolve, 20));
    else await f.adapter.onInteractionResolved({ kind: 'question', interactionId: 'question', sessionId: route.sessionId });
    assert.equal((await f.adapter.onAction(action)).accepted, false);
    assert.equal(responses.length, 0);
    if (outcome === 'abort') assert.equal(f.attempts.length, before, 'no cleanup I/O after abort');
    else {
      assert.equal(activeControl(f.cards.get(action.messageId)), null);
      await f.adapter.finish({ text: 'terminal', failed: outcome === 'failed' });
      assert.equal(f.cards.get('main').schema, '2.0');
      if (outcome === 'failed') assert.ok(f.cards.get('main').header);
    }
  });
}
for (const failure of ['unknownCreate', 'unknownPatch']) {
  test(`real Python rail ${failure} poisons delivery without retry/native recreation`, { skip: !python }, async t => {
    const f = fixture(t, { [failure]: true }); let calls = 0;
    await f.adapter.start();
    const pending = f.adapter.onInteraction(question(async () => { calls++; return { accepted: true }; }));
    if (failure === 'unknownCreate') await assert.rejects(pending, /interaction-delivery-unconfirmed/);
    else {
      await pending; const action = f.action();
      await assert.rejects(f.adapter.onAction(action), /interaction-delivery-unconfirmed/);
      assert.equal((await f.adapter.onAction(action)).accepted, false); assert.equal(calls, 1);
    }
    const attempts = f.attempts.length;
    await assert.rejects(f.adapter.finish({ text: 'do not retry' }));
    assert.equal(f.attempts.length, attempts);
    assert.equal(f.attempts.filter(x => x === 'createInteraction').length, 1);
  });
}
test('real Python multi/custom validation, same-owner wrong-message form and duplicate concurrent submit', { skip: !python }, async t => {
  const f = fixture(t), responses = [];
  await f.adapter.start();
  await f.adapter.onInteraction(question(async r => { responses.push(r); return { accepted: true }; }, [
    { id: 'multi', question: 'Multi', multiSelect: true, options: [{ label: 'A,B' }, { label: 'C、D' }] },
  ]));
  const rail = f.current(), form = find(rail.card, n => n.name?.startsWith('hfc_confirm_'));
  const action = { actor: route, messageId: rail.id, name: form.name, value: {}, formValue: { hfc_multi: ['A,B', 'C、D'], hfc_other: 'raw,custom' } };
  assert.equal((await f.adapter.onAction({ ...action, messageId: 'main' })).accepted, false);
  assert.equal((await f.adapter.onAction({ ...action, formValue: { hfc_multi: ['not-offered'] } })).accepted, false);
  assert.equal((await f.adapter.onAction({ ...action, formValue: { hfc_multi: ['A,B', 'A,B'] } })).accepted, false);
  assert.equal((await f.adapter.onAction({ ...action, formValue: { hfc_other: 123 } })).accepted, false);
  const result = await Promise.all([f.adapter.onAction(action), f.adapter.onAction(action)]);
  assert.equal(result.filter(r => r.accepted).length, 1); assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].value.answer.answers, [{ id: 'multi', selected: ['A,B', 'C、D'], custom: 'raw,custom' }]);
  assert.equal(activeControl(f.cards.get(rail.id)), null);
});
test('real Python custom-only native form and explicit responder receipt required', { skip: !python }, async t => {
  const f = fixture(t); let calls = 0;
  await f.adapter.start();
  await f.adapter.onInteraction(question(async () => { calls++; return calls === 1 ? undefined : { accepted: true }; }, [{ id: 'custom', question: 'Type answer' }]));
  const rail = f.current(), form = find(rail.card, n => n.name?.startsWith('hfc_other_'));
  const action = { actor: route, messageId: rail.id, name: form.name, value: {}, formValue: { hfc_other: 'custom answer' } };
  assert.equal((await f.adapter.onAction(action)).accepted, false, 'normal Promise is not confirmed authority');
  assert.equal((await f.adapter.onAction(action)).accepted, true);
  assert.equal(calls, 2); assert.equal(activeControl(f.cards.get(rail.id)), null);
});

test('real Python pending rail receipt barrier and shared 250ms PATCH cadence', { skip: !python }, async t => {
  let release, entered; const gate = { promise: new Promise(r => { release = r; }), entered: () => entered() };
  const ready = new Promise(r => { entered = r; }); let time = 1000;
  const f = fixture(t, { createGate: gate, adapter: { minPatchIntervalMs: 250, now: () => time, sleep: async ms => { time += ms; } } });
  const starts = []; let active = 0, maximum = 0;
  for (const name of ['create', 'patch', 'createInteraction', 'patchInteraction']) {
    const original = f.adapter.sink[name];
    f.adapter.sink[name] = async (...args) => { maximum = Math.max(maximum, ++active); if (name.startsWith('patch')) starts.push(time);
      try { return await original(...args); } finally { active--; } };
  }
  await f.adapter.start();
  const pending = f.adapter.onInteraction(question(async () => ({ accepted: true })));
  await ready; assert.equal(f.adapter.bindings.size, 0, 'no bindings before confirmed auxiliary receipt');
  const update = f.adapter.onUpdate({ type: 'tool', callId: 'tool', name: 'read' });
  release(); await pending; await update;
  await f.adapter.onAction(f.action()); await f.adapter.finish({ text: 'done' });
  assert.equal(maximum, 1, 'all main and auxiliary writes remain singleflight');
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 250, 'shared PATCH starts are spaced');
});
test('real Python auxiliary create cannot reuse the main confirmed message', { skip: !python }, async t => {
  const f = fixture(t, { reuseMain: true }); await f.adapter.start();
  await assert.rejects(f.adapter.onInteraction(question(async () => ({ accepted: true }))), /interaction-message-reused/);
  assert.equal(f.adapter.bindings.size, 0);
  await assert.rejects(f.adapter.finish({ text: 'no retry' }));
  assert.equal(f.attempts.filter(x => x === 'createInteraction').length, 1);
});
