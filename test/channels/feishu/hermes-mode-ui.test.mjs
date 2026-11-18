import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import {
  DEFAULT_FEISHU_STEP_PUSH_MODE,
  FEISHU_STEP_PUSH_MODES,
  isFeishuStepPushMode,
  normalizeFeishuStepPushMode,
} from '../../../src/channels/feishu/step-push-mode.mjs';
import { normalizeBotConnection, FEISHU_ENDPOINTS } from '../../../plugin-src/client/channels/feishu/api.js';
import { BotCard } from '../../../plugin-src/client/channels/feishu/index.js';
import { BotGeneralSettingsPage } from '../../../plugin-src/client/bot-general-settings.js';
import { en, ru, setImTranslator } from '../../../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;
const text = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const connection = (stepPushMode, stepPush = true) => normalizeBotConnection({
  botId: 'hermes_mode', connected: true, stepPushMode, stepPush,
  bot: { name: 'Hermes test bot' },
});

async function mountCard(t, initial, saves = {}) {
  let view;
  await act(async () => { view = create(React.createElement(BotCard, { connection: initial, ...saves })); });
  t.after(async () => { await act(async () => view.unmount()); });
  return view;
}

test('hermes_card is opt-in while existing mode values, fallback, and new-bot default stay unchanged', () => {
  assert.equal(FEISHU_STEP_PUSH_MODES.HERMES_CARD, 'hermes_card');
  assert.equal(DEFAULT_FEISHU_STEP_PUSH_MODE, 'streaming_card');
  assert.ok(Object.isFrozen(FEISHU_STEP_PUSH_MODES));
  for (const mode of ['post', 'live_cot', 'streaming_card', 'hermes_card']) {
    assert.equal(normalizeFeishuStepPushMode(mode), mode);
    assert.equal(isFeishuStepPushMode(mode), true);
    assert.equal(connection(mode).stepPushMode, mode, 'browser snapshot shares the host normalizer');
  }
  for (const mode of [undefined, null, '', 'off', 'HERMES_CARD', 'hermes-card', {}, true]) {
    assert.equal(normalizeFeishuStepPushMode(mode), 'post');
    assert.equal(isFeishuStepPushMode(mode), false);
    assert.equal(connection(mode).stepPushMode, 'post');
  }
});

test('Hermes remains an additional single-select option and never migrates existing selections on render', async (t) => {
  const writes = [];
  const view = await mountCard(t, connection('post'), {
    onStepPushSave: (value) => writes.push(['flag', value]),
    onStepPushModeSave: (value) => writes.push(['mode', value]),
  });
  const select = () => view.root.findByProps({ 'aria-label': '任务过程展示' });
  assert.equal(select().type, 'select');
  assert.equal(select().props.multiple, undefined);
  assert.deepEqual(select().findAllByType('option').map((node) => node.props.value), [
    'off', 'live_cot', 'streaming_card', 'hermes_card', 'post',
  ]);
  for (const mode of ['post', 'live_cot', 'streaming_card', 'hermes_card']) {
    await act(async () => view.update(React.createElement(BotCard, {
      connection: connection(mode),
      onStepPushSave: (value) => writes.push(['flag', value]),
      onStepPushModeSave: (value) => writes.push(['mode', value]),
    })));
    assert.equal(select().props.value, mode);
  }
  assert.deepEqual(writes, [], 'reading any bot must not save or migrate its configuration');
  assert.match(text(view.root), /状态、正文与可折叠过程/);
  assert.match(text(view.root), /真实统计/);
  assert.match(text(view.root), /未提供的统计不显示/);
});

test('enabling Hermes saves the flag first, switching changes only mode, and disabling preserves mode', async (t) => {
  const writes = [];
  const handlers = {
    onStepPushSave: async (value) => { writes.push(['flag', value]); },
    onStepPushModeSave: async (value) => { writes.push(['mode', value]); },
  };
  const view = await mountCard(t, connection('post', false), handlers);
  const select = () => view.root.findByProps({ 'aria-label': '任务过程展示' });
  assert.equal(select().props.value, 'off');
  await act(async () => select().props.onChange({ target: { value: 'hermes_card' } }));
  assert.deepEqual(writes, [['flag', true], ['mode', 'hermes_card']]);
  await act(async () => view.update(React.createElement(BotCard, { connection: connection('streaming_card'), ...handlers })));
  writes.length = 0;
  await act(async () => select().props.onChange({ target: { value: 'hermes_card' } }));
  assert.deepEqual(writes, [['mode', 'hermes_card']]);
  await act(async () => view.update(React.createElement(BotCard, { connection: connection('hermes_card'), ...handlers })));
  writes.length = 0;
  await act(async () => select().props.onChange({ target: { value: 'hermes_card' } }));
  assert.deepEqual(writes, []);
  await act(async () => select().props.onChange({ target: { value: 'off' } }));
  assert.deepEqual(writes, [['flag', false]]);
});

test('Hermes save failures show feedback without changing the rendered mode', async (t) => {
  const view = await mountCard(t, connection('post'), {
    onStepPushModeSave: async () => { throw new Error('mode write failed'); },
  });
  const select = () => view.root.findByProps({ 'aria-label': '任务过程展示' });
  await act(async () => select().props.onChange({ target: { value: 'hermes_card' } }));
  assert.equal(select().props.value, 'post');
  assert.equal(select().props.disabled, false);
  assert.equal(text(view.root.findByProps({ role: 'alert' })), 'mode write failed');
});

test('Hermes uses the existing independent thinking/tool panel switches without modifying the mode', async (t) => {
  let panels = { thinkingExpanded: false, toolsExpanded: true };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.setStepCardPanels) panels = payload.stepCardPanels;
    return { ok: true, value: { bots: [{
      botId: 'hermes_mode', stepPush: true, stepPushMode: 'hermes_card', stepCardPanels: panels,
    }] } };
  };
  let view;
  await act(async () => { view = create(React.createElement(BotGeneralSettingsPage, {
    channel: 'feishu', account: { botId: 'hermes_mode' }, rpcCall,
  })); });
  t.after(async () => { await act(async () => view.unmount()); });
  const switches = () => view.root.findAllByProps({ role: 'switch' });
  assert.deepEqual(switches().map((node) => node.props.checked), [false, true]);
  assert.ok(switches().every((node) => node.props.disabled === false));
  assert.equal(calls.length, 1, 'loading does not change any setting');
  await act(async () => switches()[0].props.onChange({ target: { checked: true } }));
  await act(async () => switches()[1].props.onChange({ target: { checked: false } }));
  assert.deepEqual(calls.slice(1), [
    { endpoint: FEISHU_ENDPOINTS.setStepCardPanels, payload: {
      botId: 'hermes_mode', stepCardPanels: { thinkingExpanded: true, toolsExpanded: true },
    } },
    { endpoint: FEISHU_ENDPOINTS.setStepCardPanels, payload: {
      botId: 'hermes_mode', stepCardPanels: { thinkingExpanded: true, toolsExpanded: false },
    } },
  ]);
  assert.match(text(view.root), /实时过程卡分别控制思考与工具面板，任务结束后自动收起/);
  assert.match(text(view.root), /Hermes 风格卡片共用一个过程面板，任一开关开启即展开，任务结束后保持该设置/);
});

test('all Hermes settings copy has explicit English and Russian mappings and English renders without Chinese', async (t) => {
  const keys = [
    'Hermes 风格卡片（状态、正文、过程与统计）',
    'Hermes 风格：状态、正文与可折叠过程在同一卡片中更新，结束后展示可用的真实统计；未提供的统计不显示',
    '设置任务执行过程的呈现方式：不显示、原生直播、实时卡片、Hermes 风格卡片或逐步消息',
    '实时过程卡分别控制思考与工具面板，任务结束后自动收起；Hermes 风格卡片共用一个过程面板，任一开关开启即展开，任务结束后保持该设置。',
  ];
  for (const key of keys) {
    assert.equal(typeof en[key], 'string');
    assert.notEqual(en[key], key);
    assert.doesNotMatch(en[key], /\p{Script=Han}/u);
    assert.notEqual(ru[key], en[key], 'Russian must have an explicit translation, not the English fallback');
    assert.match(ru[key], /\p{Script=Cyrillic}/u);
  }
  setImTranslator((source) => en[source] ?? source);
  t.after(() => setImTranslator(null));
  const view = await mountCard(t, connection('hermes_card'));
  const select = view.root.findByProps({ 'aria-label': 'Task progress display' });
  assert.equal(text(select.findAllByType('option').find((node) => node.props.value === 'hermes_card')), en[keys[0]]);
  assert.ok(view.root.findAllByType('p').some((node) => text(node) === en[keys[1]]));
});
