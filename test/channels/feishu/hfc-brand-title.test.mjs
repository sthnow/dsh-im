import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = process.env.HFC_PYTHON || process.env.DSH_HFC_TEST_PYTHON;
const workerPath = fileURLToPath(new URL('../../../assets/hfc/worker.py', import.meta.url));
const realTest = (name, fn) => test(name, { skip: !python }, fn);
const brand = 'DeepSeek Harness';
const body = 'Keep literal Hermes Agent in the answer, not as branding.';
function event(name, data = {}, sequence = 1) {
  return { schema_version: '1', event: name, conversation_id: 'brand-session', message_id: '7',
    chat_id: 'brand-chat', platform: 'feishu', turn_id: '7', sequence, created_at: 1700000000 + sequence,
    data: { profile_id: 'brand-profile', bot_id: 'brand-bot', ...data } };
}
// Same real-renderer fixture pattern as terminal-header, narrowed to branding.
// A second default render proves the pinned upstream still owns its old default.
const probeCode = String.raw`
import copy, importlib.util, json, sys
spec = importlib.util.spec_from_file_location('brand_worker', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
scenario = json.loads(sys.stdin.read()); worker = m.Worker()
for i, e in enumerate(scenario['events']):
    response = worker.handle({'id': i, 'op': 'event', 'event': e})
    assert response['ok'] and response['accepted'], response
session = next(iter(worker.sessions.values()))
options = dict(presentation='classic', interaction_mode='callback',
               interaction_profile_id='brand-profile',
               footer_fields=('duration', 'model', 'input_tokens', 'output_tokens', 'context', 'output_rate'))
main = copy.deepcopy(session)
if main.active_interaction and main.active_interaction.status == 'pending':
    main.active_interaction.feishu_message_id = 'dsh-display-only-standalone-rail'
raw = m.render_card_result(main, title='DeepSeek Harness', **options)
default = m.render_card_result(main, **options)
print(json.dumps(dict(response=response, raw=m.normalize_card_element_ids(raw.card),
                     default=m.normalize_card_element_ids(default.card),
                     disposition=raw.disposition, segments=list(raw.segments))))
`;
function probe(events) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', probeCode, workerPath], {
    input: JSON.stringify({ events }), encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function assertRender(result, hidden = false) {
  const expected = structuredClone(result.raw);
  if (hidden) delete expected.header;
  assert.deepEqual(result.response.card, expected, 'branding does not change normalized body, callbacks or footer');
  assert.equal(Object.hasOwn(result.response.card, 'header'), !hidden);
  assert.equal(result.response.disposition, result.disposition);
  assert.deepEqual(result.response.segments, result.segments);
  const { header: brandedHeader, ...brandedBody } = result.raw;
  const { header: originalHeader, ...originalBody } = result.default;
  assert.deepEqual(brandedBody, originalBody, 'only the outer header differs from upstream default');
}
const content = [event('message.started'), event('answer.delta', { text: body }, 2)];

realTest('real Python running card uses DeepSeek Harness only in its outer title', () => {
  const result = probe(content);
  assertRender(result);
  assert.match(result.response.card.header.title.content, /DeepSeek Harness/);
  assert.doesNotMatch(result.response.card.header.title.content, /Hermes Agent/);
  assert.match(result.default.header.title.content, /Hermes Agent/, 'upstream default remains pinned');
  assert.ok(JSON.stringify(result.response.card.body).includes(body), 'user text is never globally rebranded');
});

realTest('real Python normal completion still hides the entire outer header', () => {
  const result = probe([...content, event('message.completed', { answer: body }, 3)]);
  assertRender(result, true);
  assert.equal(result.response.summary.status, 'completed');
  assert.match(result.raw.header.title.content, /DeepSeek Harness/);
  assert.match(JSON.stringify(result.response.card), /已完成/);
});

realTest('real Python failure retains the branded warning header', () => {
  const result = probe([...content, event('message.failed', { error: 'brand failure sentinel' }, 3)]);
  assertRender(result);
  assert.equal(result.response.summary.status, 'failed');
  assert.match(result.response.card.header.title.content, /DeepSeek Harness/);
  assert.match(JSON.stringify(result.response.card), /brand failure sentinel/);
});

for (const kind of ['approval', 'clarify']) {
  realTest(`real Python pending ${kind} keeps its attention header and callback payload`, () => {
    for (const prompt of ['', 'DECISION-SENTINEL']) {
      const result = probe([...content, event('interaction.requested', { interaction_id: `brand-${kind}`,
        kind, prompt, options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }],
        allow_custom_input: kind === 'clarify' }, 3)]);
      assertRender(result);
      assert.equal(result.response.summary.interaction.status, 'pending');
      assert.match(result.response.card.header.title.content, kind === 'approval' ? /待审批/ : /待选择/);
      // Upstream intentionally puts a nonempty decision prompt in the title;
      // an empty prompt falls back to the configured application brand.
      assert.ok(result.response.interaction_card.header.title.content.includes(prompt || brand));
      assert.match(JSON.stringify(result.response.interaction_card), /interaction.select/);
      assert.equal(result.response.card.schema, '2.0');
      assert.doesNotMatch(JSON.stringify(result.response.card), /interaction.select/);
    }
  });
}
