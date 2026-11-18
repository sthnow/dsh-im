import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const workerPath = fileURLToPath(new URL('../../../assets/hfc/worker.py', import.meta.url));
const route = { runtimeNamespace: '11111111-1111-4111-8111-111111111111', botId: 'b', sessionId: 's', chatId: 'c', senderId: 'actor', turnId: '7' };
const receipt = { messageId: 'original-card', providerMessageIds: ['original-card'] };
const metrics = { model: 'model-a', provider: 'provider-a', duration: 2.5, tokens: { input_tokens: 30, output_tokens: 5 } };
const realTest = (name, fn) => test(name, { skip: !python }, fn);
function event(name, data = {}, sequence = 1) {
  return { schema_version: '1', event: name, conversation_id: 's', message_id: '7', chat_id: 'c', platform: 'feishu',
    turn_id: '7', sequence, created_at: 1700000000 + sequence, data: { profile_id: 'p', bot_id: 'b', ...data } };
}
const probeCode = String.raw`
import copy, importlib.util, json, pickle, sys
spec = importlib.util.spec_from_file_location('hfc_wrapper', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def main_session(session):
    main = copy.deepcopy(session)
    if main.active_interaction and main.active_interaction.status == 'pending':
        main.active_interaction.feishu_message_id = 'dsh-display-only-standalone-rail'
    return main
output = []
for scenario in json.loads(sys.stdin.read()):
    w = m.Worker(); frames = []
    for i, e in enumerate(scenario['events']):
        response = w.handle({'id': i, 'op': 'event', 'event': e})
        assert response['ok'], response
        session = next(iter(w.sessions.values()))
        raw = m.render_card_result(main_session(session), title='DeepSeek Harness', presentation='classic', interaction_mode='callback', interaction_profile_id='p')
        frames.append({'response': response, 'raw': m.normalize_card_element_ids(raw.card),
                       'disposition': raw.disposition, 'segments': list(raw.segments)})
    if 'override' in scenario:
        session = next(iter(w.sessions.values()))
        for key, value in scenario['override'].items():
            if key == 'interaction_status':
                session.active_interaction.status = value
            else:
                setattr(session, key, value)
        # Render a rejected stale event against a real CardSession without
        # smuggling synthetic display metadata into an accepted sidecar event.
        before = pickle.dumps(session)
        response = w.handle({'id': 100, 'op': 'event', 'event': scenario['events'][0]})
        assert response['ok'] and not response['accepted'], response
        assert pickle.dumps(session) == before, 'worker must not mutate the committed CardSession'
        raw = m.render_card_result(main_session(session), title='DeepSeek Harness', presentation='classic', interaction_mode='callback', interaction_profile_id='p')
        before = pickle.dumps(session)
        m.postprocess_card(session, raw.card)
        assert pickle.dumps(session) == before, 'postprocessing must not mutate CardSession'
        frames.append({'response': response, 'raw': m.normalize_card_element_ids(raw.card),
                       'disposition': raw.disposition, 'segments': list(raw.segments)})
    session = next(iter(w.sessions.values()))
    output.append({'frames': frames, 'route': list(next(iter(w.sessions))),
                   'delivery_kind': session.delivery_kind, 'reply_to_message_id': session.reply_to_message_id})
print(json.dumps(output))
`;
function probe(scenarios) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', probeCode, workerPath], {
    input: JSON.stringify(scenarios), encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function assertFrame(frame, hide) {
  const expected = structuredClone(frame.raw);
  if (hide) delete expected.header;
  assert.deepEqual(frame.response.card, expected, 'only the top-level success header may change after ID normalization');
  assert.equal(Object.hasOwn(frame.response.card, 'header'), !hide);
  assert.equal(frame.response.disposition, frame.disposition, 'delivery disposition is untouched');
  assert.deepEqual(frame.response.segments, frame.segments, 'delivery segments are untouched');
}
function text(card) { return JSON.stringify(card); }
const contentEvents = [
  event('message.started'),
  event('thinking.delta', { text: 'REASONING-SENTINEL', mode: 'append_block' }, 2),
  event('answer.delta', { text: 'pre-tool narrative' }, 3),
  event('tool.updated', { tool_id: 'tool', call_id: 'tool', name: 'read_file', status: 'running', detail: 'TOOL-SENTINEL' }, 4),
  event('tool.updated', { tool_id: 'tool', call_id: 'tool', name: 'read_file', status: 'completed', detail: 'TOOL-SENTINEL' }, 5),
];
function requested(kind) {
  return event('interaction.requested', { interaction_id: 'interaction', kind, prompt: 'DECISION-SENTINEL',
    options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }], allow_custom_input: kind === 'clarify' }, 2);
}

realTest('worker success removes only green top-level header; body, tools, reasoning and statistics are byte-equivalent', () => {
  const [result] = probe([{ events: [...contentEvents, event('message.completed', { ...metrics, answer: 'ANSWER-SENTINEL' }, 6)] }]);
  for (const frame of result.frames.slice(0, -1)) assertFrame(frame, false);
  const frame = result.frames.at(-1);
  assert.equal(frame.raw.header.template, 'green');
  assert.match(text(frame.raw.header), /DeepSeek Harness/);
  assert.match(text(frame.raw.header), /本轮回复结束/);
  assertFrame(frame, true);
  assert.match(text(result.frames[1].response.card), /REASONING-SENTINEL/, 'live reasoning is retained while running');
  // Classic upstream archives the pre-tool answer into a reasoning panel; live
  // thinking is not necessarily copied into the final card. Preserve both rules.
  for (const marker of ['ANSWER-SENTINEL', 'pre-tool narrative', 'read_file', '已完成', 'provider-a/model-a', '↑30', '↓5']) {
    assert.ok(text(frame.response.card).includes(marker), `retained ${marker}`);
  }
  assert.equal(frame.response.summary.status, 'completed');
  assert.deepEqual(result.route, ['feishu', 'p', 'b', 's', 'c', '', '7']);
  assert.equal(result.delivery_kind, 'chat');
  assert.equal(result.reply_to_message_id, '', 'no fabricated native-reply routing');
  assert.equal(frame.response.disposition, 'card');
});

for (const outcome of ['failed', 'interrupted', 'incomplete']) {
  realTest(`worker message.completed with unsuccessful turn_outcome=${outcome} retains warning header and footer`, () => {
    const [result] = probe([{ events: [...contentEvents, event('message.completed', { ...metrics, answer: 'terminal', turn_outcome: outcome }, 6)] }]);
    const frame = result.frames.at(-1); assertFrame(frame, false);
    assert.equal(frame.response.summary.status, 'failed');
    assert.match(text(frame.response.card), /本轮执行失败|本轮已中断|未报告执行完成/);
    assert.match(text(frame.response.card), /已停止/);
  });
}
realTest('worker message.failed preserves complete upstream warning structure and metrics', () => {
  const [result] = probe([{ events: [...contentEvents, event('message.failed', { ...metrics, error: 'FAILURE-SENTINEL' }, 6)] }]);
  const frame = result.frames.at(-1); assertFrame(frame, false);
  assert.equal(frame.response.summary.status, 'failed');
  assert.match(text(frame.response.card), /FAILURE-SENTINEL/);
  assert.match(text(frame.response.card), /已停止/);
  assert.match(text(frame.response.card), /↑30/);
});

for (const kind of ['approval', 'clarify']) {
  realTest(`worker pending ${kind} header, callbacks and routing remain untouched`, () => {
    const [result] = probe([{ events: [event('message.started'), requested(kind)] }]);
    const frame = result.frames.at(-1); assertFrame(frame, false);
    assert.equal(frame.response.summary.interaction.status, 'pending');
    assert.match(text(frame.response.card.header), kind === 'approval' ? /待审批/ : /待选择/);
    assert.match(text(frame.response.interaction_card), /interaction.select/);
    assert.equal(frame.response.card.schema, '2.0');
    assert.doesNotMatch(text(frame.response.card), /interaction.select/);
    assert.deepEqual(result.route, ['feishu', 'p', 'b', 's', 'c', '', '7']);
  });
  for (const interactionStatus of ['pending', 'paused']) {
    realTest(`worker completed status does not hide ${interactionStatus} ${kind} (guard and non-mutation)`, () => {
      const [result] = probe([{ events: [event('message.started'), requested(kind)], override: { status: 'completed', interaction_status: interactionStatus } }]);
      assertFrame(result.frames.at(-1), false);
      assert.equal(result.frames.at(-1).response.summary.interaction.status, interactionStatus);
    });
  }
}

for (const override of [
  { status: 'running', display_status: 'completed' },
  { status: 'completed', display_status: 'failed' },
  { status: 'completed', display_status: 'waiting' },
  { status: 'completed', answer_text: 'working on results; will continue when ready' },
]) {
  realTest(`worker retains non-success display state: ${JSON.stringify(override)}`, () => {
    const [result] = probe([{ events: [event('message.started'), event('answer.delta', { text: 'draft' }, 2)], override }]);
    assertFrame(result.frames.at(-1), false);
  });
}

for (const mode of ['success', 'failed', 'interrupted']) {
  realTest(`real adapter + Python ${mode}: same-card PATCH, footer and route remain intact`, async t => {
    const raw = new HfcWorker({ python }), events = [], cards = [];
    let creates = 0, natives = 0, clock = 1000;
    const adapter = new DshHfcAdapter({ route, minRenderIntervalMs: 0, minPatchIntervalMs: 0, now: () => clock,
      worker: { start: () => raw.start(), reset: () => raw.reset(), close: () => raw.close(),
        async event(e) { events.push(structuredClone(e)); return raw.event(e); } },
      sink: { async create(card) { creates++; cards.push(card); return receipt; },
        async patch(card) { cards.push(card); return receipt; }, async native() { natives++; return receipt; } } });
    t.after(() => adapter.close());
    await adapter.start(); assert.ok(cards.at(-1).header);
    await adapter.onUpdate({ type: 'reasoning', text: 'REASONING-SENTINEL', step: 0 });
    await adapter.onUpdate({ type: 'tool', callId: 'one', name: 'read_file', detail: 'file' });
    await adapter.onUpdate({ type: 'tool-result', callId: 'one', name: 'read_file', result: 'done' });
    await adapter.onUpdate({ type: 'metrics', model: 'model-a', provider: 'provider-a', inputTokens: 30, outputTokens: 5 });
    assert.ok(cards.at(-1).header, 'running card keeps its header');
    clock = 3500;
    const result = await adapter.finish({ text: 'FINAL-SENTINEL', failed: mode === 'failed', interrupted: mode === 'interrupted' });
    assert.equal(Object.hasOwn(cards.at(-1), 'header'), mode !== 'success');
    assert.match(text(cards.at(-1)), /FINAL-SENTINEL/);
    assert.match(text(cards.at(-1)), /provider-a\/model-a/);
    assert.match(text(cards.at(-1)), /↑30/); assert.match(text(cards.at(-1)), /↓5/);
    assert.match(text(cards.at(-1)), mode === 'success' ? /已完成/ : /已停止/);
    assert.equal(creates, 1); assert.equal(natives, 0);
    assert.equal(result.disposition, 'card'); assert.deepEqual(result.segments, []);
    assert.equal(events.at(-1).event, mode === 'success' ? 'message.completed' : 'message.failed');
    assert.ok(events.every(e => e.conversation_id === route.sessionId && e.message_id === route.turnId && e.chat_id === route.chatId
      && e.turn_id === route.turnId && e.data.profile_id === route.runtimeNamespace && e.data.bot_id === route.botId));
    assert.ok(events.every(e => !Object.hasOwn(e.data, 'reply_to_message_id') && !Object.hasOwn(e.data, 'delivery_kind')));
    const count = cards.length; await adapter.finish({ text: 'do not resend' }); assert.equal(cards.length, count);
  });
}

realTest('real adapter pending clarification keeps header and authority until original responder accepts', async t => {
  const cards = [], responses = [];
  const adapter = new DshHfcAdapter({ worker: new HfcWorker({ python }), route, minRenderIntervalMs: 0, minPatchIntervalMs: 0,
    sink: { async create(card) { cards.push(card); return receipt; }, async patch(card) { cards.push(card); return receipt; },
      async createInteraction(id, card) { cards.push(card); return { messageId: `rail:${id}` }; },
      async patchInteraction(id, messageId, card) { cards.push(card); return { messageId }; },
      async native() { assert.fail('no extra native message'); } } });
  t.after(() => adapter.close());
  await adapter.start();
  await adapter.onInteraction({ kind: 'question', interactionId: 'question', rpcId: 'rpc', sessionId: route.sessionId,
    payload: { sessionId: route.sessionId, questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] },
    async respond(response) { responses.push(response); return { accepted: true }; } });
  assert.match(text(cards.at(-1).header), /待选择/);
  await assert.rejects(adapter.finish({ text: 'too early' }), /interaction-still-pending/);
  const buttons = [];
  function visit(node) { if (!node || typeof node !== 'object') return; if (node.value?.hfc_action === 'interaction.select') buttons.push(node.value); for (const child of Object.values(node)) visit(child); }
  visit(cards.at(-1)); assert.ok(buttons.length);
  assert.equal((await adapter.onAction({ actor: route, messageId: `rail:${buttons[0].interaction_id}`, value: structuredClone(buttons[0]) })).accepted, true);
  assert.equal(responses.length, 1);
  assert.ok(cards.at(-1).header, 'resolved interaction alone is not a successful terminal event');
  await adapter.finish({ text: 'final after accepted response' });
  assert.equal(cards.at(-1).header, undefined);
  assert.match(text(cards.at(-1)), /已完成/);
});
