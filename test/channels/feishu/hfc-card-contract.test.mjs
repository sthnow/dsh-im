import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const workerPath = fileURLToPath(new URL('../../../assets/hfc/worker.py', import.meta.url));
const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '7' };
const receipt = { messageId: 'message', providerMessageIds: ['message'] };
const cardResult = () => ({ accepted: true, disposition: 'card', segments: [], card: { schema: '2.0', body: { elements: [] } } });
function timedAdapter({ patchError, sleep: customSleep } = {}) {
  let time = 1000;
  const patches = [], sleeps = [], events = [];
  const worker = { async start() {}, async reset() {}, async close() {}, async event(e) { events.push(e); return cardResult(); } };
  const adapter = new DshHfcAdapter({ worker, route, minRenderIntervalMs: 0,
    now: () => time, sleep: customSleep ?? (async ms => { sleeps.push(ms); time += ms; }),
    sink: { async create() { return receipt; }, async patch(card) { patches.push({ time, card }); if (patchError) throw patchError; return receipt; }, async native() { assert.fail('no native retry'); } } });
  return { adapter, patches, sleeps, events };
}
// Deliberately narrower than a full platform validator: element-ID and schema
// family checks must actually reject bad SDK input, not merely count sends.
function nodes(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value) && typeof value.tag === 'string') out.push(value);
  for (const [key, child] of Object.entries(value)) if (key !== 'value') nodes(child, out);
  return out;
}
function contract(card) {
  assert.ok(card && typeof card === 'object');
  const ids = nodes(card).filter(n => Object.hasOwn(n, 'element_id')).map(n => n.element_id);
  for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_]{0,19}$/, `invalid element_id: ${id}`);
  assert.equal(new Set(ids).size, ids.length, 'element IDs are globally unique');
  if (card.schema === '2.0') {
    assert.ok(Array.isArray(card.body?.elements));
    assert.equal(nodes(card).some(n => n.tag === 'action'), false, 'schema2 cannot contain schema1 action');
  } else {
    assert.equal(card.schema, undefined, 'only explicit schema2 or upstream implicit schema1');
    assert.ok(Array.isArray(card.elements));
  }
  return ids;
}
function event(name, data = {}, sequence = 1) {
  return { schema_version: '1', event: name, conversation_id: 's', message_id: '7', chat_id: 'c', platform: 'feishu',
    turn_id: '7', sequence, created_at: 1700000000 + sequence, data: { profile_id: 'p', bot_id: 'b', ...data } };
}
const pythonProbe = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('hfc_wrapper', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
requests = json.loads(sys.stdin.read()); w = m.Worker(); output=[]
for i, e in enumerate(requests):
    response = w.handle({'id': i, 'op': 'event', 'event': e})
    assert response['ok'], response
    session = next(iter(w.sessions.values()))
    raw = m.render_card_result(session, presentation='classic', interaction_mode='callback', interaction_profile_id='p', title='DeepSeek Harness').card
    aux_raw = m.render_legacy_interaction_callback_card(session, title='DeepSeek Harness', interaction_profile_id='p') if session.active_interaction else None
    output.append({'card': response['card'], 'raw': raw, 'interaction_card': response['interaction_card'], 'aux_raw': aux_raw})
print(json.dumps(output))
`;
function probe(events, code = pythonProbe) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', code, workerPath], { input: JSON.stringify(events), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function withoutIds(card) {
  if (Array.isArray(card)) return card.map(withoutIds);
  if (!card || typeof card !== 'object') return card;
  return Object.fromEntries(Object.entries(card).filter(([key]) => key !== 'element_id').map(([key, value]) => [key, key === 'value' ? value : withoutIds(value)]));
}

test('eight FIFO tool states coalesce bounded PATCHes; terminal uses same 250ms throttle', async () => {
  const { adapter, patches, sleeps, events } = timedAdapter();
  try {
    await adapter.start();
    await Promise.all(Array.from({ length: 8 }, (_, i) => adapter.onUpdate({ type: 'tool', callId: `tool-${i}`, name: 'read' })));
    await adapter.finish({ text: 'terminal flush' });
    assert.equal(events.filter(e => e.event === 'tool.updated').length, 8, 'all tool state transitions are applied');
    assert.ok(patches.length <= 2, 'terminal absorbs all unsent tool drafts');
    assert.equal(events.at(-1).event, 'message.completed');
    assert.equal(adapter.finished, true);
    for (let i = 1; i < patches.length; i++) assert.ok(patches[i].time - patches[i - 1].time >= 250);
    for (let start = 0; start < patches.length; start++) assert.ok(patches.filter(p => p.time >= patches[start].time && p.time < patches[start].time + 1000).length <= 5);
    assert.ok(sleeps.every(ms => ms <= 250));
  } finally { await adapter.close(); }
});

test('unknown PATCH failure never retries on another update or terminal flush', async () => {
  const error = Object.assign(new Error('patch-outcome-unknown'), { code: 'patch-outcome-unknown' });
  const { adapter, patches } = timedAdapter({ patchError: error });
  try {
    await adapter.start();
    await adapter.onUpdate({ type: 'tool', callId: 'one' });
    await new Promise(resolve => setTimeout(resolve, 1)); await adapter.publishTail;
    assert.equal(adapter.publishError, error);
    await assert.rejects(adapter.onUpdate({ type: 'tool', callId: 'two' }));
    await assert.rejects(adapter.finish({ text: 'must not resend' }));
    assert.equal(patches.length, 1);
    assert.equal(adapter.finished, false);
  } finally { await adapter.close(); }
});

test('PATCH throttle sleep is abortable and never sends queued or terminal work after abort', async () => {
  const abort = new AbortController(); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let sleeps = 0, patches = 0;
  const adapter = new DshHfcAdapter({ route, signal: abort.signal, minRenderIntervalMs: 0, now: () => 1000,
    sleep(ms, signal) {
      sleeps++; assert.equal(ms, 250); assert.equal(signal.aborted, false); entered();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('sleep-aborted')), { once: true }));
    },
    worker: { async start() {}, async close() {}, async event() { return cardResult(); } },
    sink: { async create() { return receipt; }, async patch() { patches++; return receipt; }, async native() { assert.fail(); } },
  });
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'tool', callId: 'first' });
    await new Promise(resolve => setTimeout(resolve, 1)); await adapter.publishTail;
    await adapter.onUpdate({ type: 'tool', callId: 'second' });
    await waiting; abort.abort(); await adapter.publishTail;
    assert.match(adapter.publishError?.message ?? '', /sleep-aborted|adapter-closed/);
    await assert.rejects(adapter.finish({ text: 'terminal' }), /adapter-closed/);
    assert.equal(sleeps, 1); assert.equal(patches, 1);
  } finally { await adapter.close(); }
});

test('default timer cancels immediately on AbortSignal without a second PATCH', async () => {
  const abort = new AbortController(); let count = 0;
  const adapter = new DshHfcAdapter({ route, signal: abort.signal, minRenderIntervalMs: 0,
    worker: { async start() {}, async close() {}, async event() { return cardResult(); } },
    sink: { async create() { return receipt; }, async patch() { count++; return receipt; }, async native() { assert.fail(); } },
  });
  try {
    await adapter.start(); await adapter.onUpdate({ type: 'tool', callId: 'first' });
    await new Promise(resolve => setTimeout(resolve, 1)); await adapter.publishTail;
    await adapter.onUpdate({ type: 'tool', callId: 'second' });
    await new Promise(resolve => setTimeout(resolve, 1)); abort.abort(); await adapter.publishTail;
    await assert.rejects(adapter.finish({ text: 'terminal' }), /adapter-closed/);
    assert.equal(count, 1);
  } finally { await adapter.close(); }
});

test('contract-backed mock SDK rejects invalid IDs, duplicate IDs and wrong schema family', () => {
  const valid = { schema: '2.0', body: { elements: [{ tag: 'markdown', element_id: 'ok', content: 'x' }] } };
  contract(valid);
  for (const id of ['', 'a'.repeat(21), 'bad-id', '1starts_numeric', '_starts_underscore', 123]) assert.throws(() => contract({ ...valid, body: { elements: [{ tag: 'markdown', element_id: id }] } }));
  assert.throws(() => contract({ ...valid, body: { elements: [{ tag: 'markdown', element_id: 'x' }, { tag: 'hr', element_id: 'x' }] } }));
  assert.throws(() => contract({ ...valid, body: { elements: [{ tag: 'action', actions: [] }] } }));
});

test('real Python tool/reasoning/terminal cards have short unique IDs without dropping presentation', { skip: !python }, () => {
  const results = probe([
    event('message.started'),
    event('thinking.delta', { text: 'real reasoning', mode: 'append_block' }, 2),
    event('answer.delta', { text: 'pre-tool narrative archived by upstream' }, 3),
    event('tool.updated', { tool_id: 'tool', call_id: 'tool', name: 'read_file', status: 'running', detail: 'file' }, 4),
    event('tool.updated', { tool_id: 'tool', call_id: 'tool', name: 'read_file', status: 'completed', detail: 'done' }, 5),
    event('message.completed', { answer: 'final answer' }, 6),
  ]);
  for (const kind of ['toolentry', 'reasoningentry']) assert.ok(results.some(({ raw }) => nodes(raw).some(n => n.element_id?.includes(kind) && n.element_id.length > 20)), `fixture renders overlong ${kind} IDs`);
  assert.equal(results[0].card.schema, '2.0');
  for (const [index, { card, raw }] of results.entries()) {
    contract(card);
    const expected = withoutIds(raw);
    if (index === results.length - 1) delete expected.header; // fixture ends in successful message.completed
    assert.deepEqual(withoutIds(card), expected, 'only element identity and successful terminal header may change');
  }
});

test('real Python ordinary/question schema contract and original callbacks survive adapter binding', { skip: !python }, async () => {
  const results = probe([event('message.started'), event('interaction.requested', {
    interaction_id: 'question:q:0', kind: 'clarify', prompt: 'Choose', description: 'descriptive context',
    options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }], allow_custom_input: true,
  }, 2)]);
  for (const { card, raw, interaction_card, aux_raw } of results) { contract(card); if (interaction_card) { contract(interaction_card); assert.deepEqual(withoutIds(interaction_card), withoutIds(aux_raw), 'exact public standalone renderer contract'); } else assert.deepEqual(withoutIds(card), withoutIds(raw)); }
  assert.equal(results[0].card.schema, '2.0', 'ordinary card is schema2');
  assert.equal(results[1].card.schema, '2.0', 'main remains schema2');
  assert.equal(results[1].interaction_card.schema, undefined, 'standalone upstream question intentionally uses implicit schema1');
  const cards = [], responses = [];
  const adapter = new DshHfcAdapter({ worker: new HfcWorker({ python }), route, minPatchIntervalMs: 0,
    sink: { async create(card) { contract(card); cards.push(card); return receipt; }, async patch(card) { contract(card); cards.push(card); return receipt; }, async createInteraction(id, card) { contract(card); cards.push(card); return { messageId: `rail:${id}` }; }, async patchInteraction(id, messageId, card) { contract(card); cards.push(card); return { messageId }; }, async native() { return receipt; } } });
  try {
    await adapter.start();
    await adapter.onInteraction({ kind: 'question', interactionId: 'question', rpcId: 'rpc', sessionId: 's',
      payload: { sessionId: 's', questions: [{ id: 'q', question: 'Choose', header: 'description', options: [{ label: 'A' }, { label: 'B' }] }] },
      async respond(response) { responses.push(response); return { accepted: true }; } });
    const button = nodes(cards.at(-1)).find(n => n.value?.hfc_action === 'interaction.select');
    assert.ok(button);
    const action = { actor: route, messageId: `rail:${button.value.interaction_id}`, value: structuredClone(button.value) };
    assert.equal((await adapter.onAction(action)).accepted, true);
    assert.equal((await adapter.onAction(action)).accepted, false);
    assert.deepEqual(responses[0].value.answer.answers, [{ id: 'q', selected: ['A'] }]);
    assert.equal(responses.length, 1);
  } finally { await adapter.close(); }
});

test('real Python wrapper rewrites references deterministically but never embedded business values', { skip: !python }, () => {
  const code = String.raw`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('hfc_wrapper', sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
normalize=m.normalize_card_element_ids
long='auxiliary_timeline_toolentry_0'
card={'schema':'2.0','body':{'elements':[
 {'tag':'markdown','element_id':long,'content':long},
 {'tag':'button','element_id':'safe','behaviors':[{'type':'update','target_element_id':long,'element_ids':[long,'safe']}],
  'value':{'element_id':long,'target_element_id':long,'nested':{'tag':'markdown','element_id':long}}},
 {'tag':'hr','element_id':'safe'}, {'tag':'hr','element_id':''},
 {'tag':'hr','element_id':'1starts_numeric'}, {'tag':'hr','element_id':'_starts_underscore'}]}}
a=normalize(card); b=normalize(card)
assert a==b
print(json.dumps({'card':a,'original':card}))
`;
  const { card, original } = probe([], code); contract(card);
  const [target, button, duplicate] = card.body.elements;
  assert.equal(button.behaviors[0].target_element_id, target.element_id);
  assert.deepEqual(button.behaviors[0].element_ids, [target.element_id, button.element_id]);
  assert.notEqual(duplicate.element_id, button.element_id);
  assert.deepEqual(button.value, original.body.elements[1].value);
  assert.equal(target.content, original.body.elements[0].content);
  assert.equal(original.body.elements[0].element_id, 'auxiliary_timeline_toolentry_0', 'normalizer must not mutate upstream card');
});
