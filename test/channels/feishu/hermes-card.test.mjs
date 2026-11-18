// SPDX-License-Identifier: MIT
// Copyright (c) 2026 xmanrui
import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesCard } from '../../../src/channels/feishu/hermes-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

const card = (blocks, options) => JSON.parse(hermesCard(blocks, options));
const panel = value => value.body.elements.find(element => element.tag === 'collapsible_panel');
const footer = value => value.body.elements.find(element => element.text_size === 'notation');
const blocks = [
  { kind: 'notes', lines: ['检查配置中'], omitted: 2 },
  { kind: 'tools', lines: ['⏳ read running', '❌ write failed', '⏹ test stopped'], omitted: 1 },
  { kind: 'message', text: '**最终答案**\n\n```js\nconst ok = true;\n```' },
];

for (const [status, template, title] of [
  ['running', 'blue', '⚙️ 运行中'],
  ['waiting', 'orange', '⏳ 等待中'],
  ['completed', 'green', '✅ 本轮回复已结束'],
  ['stopped', 'red', '⏹ 已停止'],
  ['failed', 'red', '❌ 执行失败'],
  ['sealed', 'default', '🤖 助手'],
]) {
  test(`Hermes ${status} uses an honest, unique header state`, () => {
    const value = card(blocks, { status });
    assert.equal(value.schema, '2.0');
    if (status === 'completed') {
      assert.equal(value.header, undefined);
      assert.equal(value.body.elements.at(-2).tag, 'hr');
      assert.equal(footer(value).content, title);
    } else {
      assert.deepEqual(value.header, { title: { tag: 'plain_text', content: title }, template });
      assert.equal(footer(value), undefined);
    }
    assert.equal(JSON.stringify(value).split(title).length - 1, 1);
    if (status === 'sealed' || status === 'stopped' || status === 'failed') {
      assert.doesNotMatch(JSON.stringify(value), /已完成|✅|success|completed/u);
    }
  });
}

test('Hermes defaults to running and never invents a successful unknown state', () => {
  assert.equal(card([]).header.template, 'blue');
  for (const status of ['mystery', 'toString', null]) {
    assert.deepEqual(card([], { status }).header, card([]).header);
  }
});

test('Hermes puts complete Markdown answers first without trimming or truncating', () => {
  const text = '  # 完整回答\n\n' + '中😀\\\"\n'.repeat(8000) + '\n最后一行\n  ';
  const source = [...blocks, { kind: 'message', text }, { text: 'legacy untyped message' }];
  const snapshot = structuredClone(source);
  const value = card(source);
  const answers = value.body.elements.filter(element => element.tag === 'markdown' && element.text_size === 'normal');
  assert.deepEqual(answers.map(element => element.content), [blocks[2].text, text, 'legacy untyped message']);
  assert.equal(value.body.elements[3].content, '**工具执行**\n' + blocks[1].lines.join('\n'));
  assert.equal(value.body.elements[4].tag, 'collapsible_panel');
  assert.ok(Buffer.byteLength(hermesCard(source)) > 24_000, 'caller owns capacity splitting');
  assert.deepEqual(source, snapshot, 'renderer does not mutate caller data');
});

test('Hermes combines notes/tools into one flat small-text execution panel', () => {
  const value = card(blocks);
  const details = panel(value);
  assert.equal(value.body.elements.filter(element => element.tag === 'collapsible_panel').length, 1);
  assert.equal(details.header.title.content, '执行过程');
  assert.ok(details.elements.every(element => element.tag === 'markdown' && element.text_size === 'small'));
  assert.match(details.elements[0].content, /^\*\*进度说明\*\*\n检查配置中/u);
  assert.doesNotMatch(details.elements[0].content, /思考|推理/u);
  assert.match(details.elements[0].content, /另有 2 条未显示/u);
  assert.match(details.elements[1].content, /另有 1 条未显示/u);
  for (const line of blocks[1].lines) assert.ok(details.elements[1].content.includes(line));
  assert.doesNotMatch(JSON.stringify(details), /✅|success|completed/u);
});

test('visible tool summary follows answers and shares the process states with bounded output', () => {
  const lines = ['⏳ read — safe query', '✅ search — safe path', '❌ write — failed', '⏹ test — stopped'];
  const value = card([{ kind: 'tools', lines }, { kind: 'message', text: 'answer' }],
    { stepCardPanels: { thinkingExpanded: false, toolsExpanded: false } });
  const [answer, summary, details] = value.body.elements;
  assert.equal(answer.content, 'answer');
  assert.equal(summary.content, '**工具执行**\n' + lines.slice(0, 3).join('\n'));
  assert.equal(details.tag, 'collapsible_panel');
  assert.equal(details.expanded, false);
  assert.ok(lines.every(line => details.elements[0].content.includes(line)));
  const long = card([{ kind: 'tools', lines: ['⏳ ' + '中😀\\"'.repeat(5000)] }]);
  assert.ok(Buffer.byteLength(JSON.stringify(long.body.elements[0].content), 'utf8') < 1300);
  assert.ok(long.body.elements[0].content.endsWith('…'));
});

test('Hermes accepts true reasoning without relabeling progress notes', () => {
  const value = card([
    { kind: 'notes', lines: ['这是进度'] },
    { kind: 'reasoning', lines: ['真实推理内容'] },
    { kind: 'reasoning', text: '另一段真实推理' },
  ]);
  assert.deepEqual(panel(value).elements.map(element => element.content), [
    '**进度说明**\n这是进度', '**推理过程**\n真实推理内容', '**推理过程**\n另一段真实推理',
  ]);
});

test('Hermes OR expansion respects all combinations in running and terminal states', () => {
  for (const status of ['running', 'waiting', 'completed', 'stopped', 'failed', 'sealed']) {
    for (const thinkingExpanded of [false, true]) {
      for (const toolsExpanded of [false, true]) {
        const value = card(blocks, { status, stepCardPanels: { thinkingExpanded, toolsExpanded } });
        assert.equal(panel(value).expanded, thinkingExpanded || toolsExpanded, `${status}/${thinkingExpanded}/${toolsExpanded}`);
      }
    }
  }
  assert.equal(panel(card(blocks)).expanded, true, 'shared default toolsExpanded=true');
});

test('Hermes has no empty process panel, unknown block text, or fake footer', () => {
  for (const source of [undefined, null, {}, [], [
    null, { kind: 'notes', lines: ['', ' ', null, 3], omitted: 4 },
    { kind: 'tools', lines: [] }, { kind: 'reasoning', text: ' ' },
    { kind: 'message', text: ' ' }, { kind: 'mystery', text: 'must not surface' },
  ]]) {
    const value = card(source);
    assert.equal(panel(value), undefined);
    assert.equal(footer(value), undefined);
    assert.deepEqual(value.body.elements, [{ tag: 'markdown', content: ' ', text_size: 'normal' }]);
  }
  assert.equal(footer(card([{ kind: 'message', text: 'x'.repeat(100000) }], { status: 'completed' })).content, '✅ 本轮回复已结束');
});

test('completed footer follows content and separator with only supplied measurements', () => {
  const value = card(blocks, { status: 'completed', metrics: { durationMs: 1250, outputTokens: 42 } });
  assert.equal(value.header, undefined);
  assert.equal(value.body.elements.at(-3).tag, 'collapsible_panel');
  assert.deepEqual(value.body.elements.at(-2), { tag: 'hr' });
  assert.deepEqual(value.body.elements.at(-1), { tag: 'markdown', text_size: 'notation', content: '✅ 本轮回复已结束 · 耗时 1.25 s · 输出 42 tokens' });
  assert.doesNotMatch(footer(value).content, /速度|输入|模型/u);
});

test('Hermes completion labels describe the reply, not background task completion', () => {
  try {
    for (const [language, expected] of [
      ['zh', '✅ 本轮回复已结束'], ['en', '✅ Reply ended'], ['ru', '✅ Ответ завершён'],
    ]) {
      setImHostLanguage(language);
      const value = card([{ kind: 'message', text: 'reply' }], { status: 'completed' });
      assert.equal(value.header, undefined);
      assert.equal(footer(value).content, expected);
      assert.doesNotMatch(footer(value).content, /后台.*完成|all.*tasks.*completed|background.*completed/iu);
    }
  } finally {
    setImHostLanguage('zh');
  }
});

test('Hermes footer displays only supplied validated metrics in notation size', () => {
  const value = card(blocks, { metrics: {
    durationMs: 1250, model: 'provider/model', inputTokens: 123,
    outputTokens: 42, contextTokens: 165, contextWindow: 128000, outputRate: 23.456,
    totalTokens: 9999, estimatedTokens: 7777, extra: 'must not surface',
  } });
  assert.equal(footer(value).content,
    '耗时 1.25 s · 模型 provider/model · 输入 123 tokens · 输出 42 tokens · 上下文 165 / 128000 tokens · 速度 23.46 tokens/s');
  assert.equal(value.body.elements.at(-1), footer(value));
  assert.doesNotMatch(footer(value).content, /9999|7777|must not surface/u);
});

test('Hermes sparse metrics never fill missing fields or infer output rate', () => {
  for (const [metrics, expected] of [
    [{ durationMs: 0 }, '耗时 0 ms'],
    [{ model: 'model' }, '模型 model'],
    [{ inputTokens: 0 }, '输入 0 tokens'],
    [{ outputTokens: 0 }, '输出 0 tokens'],
    [{ contextTokens: 0 }, '上下文 0 tokens'],
    [{ contextWindow: 64000 }, '上下文窗口 64000 tokens'],
    [{ outputRate: 0 }, '速度 0 tokens/s'],
    [{ outputRate: 12.5 }, '速度 12.5 tokens/s'],
    [{ durationMs: 1000, outputTokens: 50 }, '耗时 1 s · 输出 50 tokens'],
  ]) assert.equal(footer(card([], { metrics })).content, expected);
});

test('Hermes ignores invalid numeric metrics without coercion', () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, '123', true, {}, []]) {
    const metrics = Object.fromEntries([
      'durationMs', 'inputTokens', 'outputTokens', 'contextTokens', 'contextWindow', 'outputRate',
    ].map(key => [key, invalid]));
    metrics.model = typeof invalid === 'string' ? '' : invalid;
    assert.equal(footer(card([], { metrics })), undefined, `invalid ${String(invalid)}`);
  }
  for (const metrics of [null, [], {}, { contextWindow: 0 }, {
    inputTokens: 1.2, outputTokens: Number.MAX_SAFE_INTEGER + 1, contextTokens: 0.5,
  }]) assert.equal(footer(card([], { metrics })), undefined);
});

test('Hermes footer model is inline text rather than injected markup', () => {
  const value = card([], { metrics: { model: '  model\n**name** <at id=all>all</at> ' } });
  assert.equal(footer(value).content, '模型 model \\*\\*name\\*\\* &lt;at id=all&gt;all&lt;/at&gt;');
});

test('Hermes footer normalizes model whitespace and escapes Markdown metacharacters', () => {
  const model = '  alpha   beta\n\tname_*[x](y)\\end  ';
  assert.equal(footer(card([], { metrics: { model } })).content,
    '模型 alpha beta name\\_\\*\\[x\\]\\(y\\)\\\\end');
});

test('Hermes labels follow the existing host language without shared dictionary edits', () => {
  try {
    for (const [language, expected] of [['en', '⏹ Stopped'], ['ru', '⏹ Остановлено']]) {
      setImHostLanguage(language);
      const value = card(blocks, { status: 'stopped', metrics: { durationMs: 500 } });
      assert.equal(value.header.title.content, expected);
      assert.doesNotMatch(panel(value).header.title.content, /[\u3400-\u9fff]/u);
      assert.doesNotMatch(footer(value).content, /[\u3400-\u9fff]/u);
    }
  } finally {
    setImHostLanguage('zh');
  }
});
