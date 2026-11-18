/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xmanrui
 * See the repository LICENSE for the existing MIT permission notice.
 *
 * Optional Hermes-inspired presentation, independently implemented for dsh-im.
 * This module is deliberately separate from the legacy card builders.
 */

import { getImHostLanguage } from '../shared/i18n.mjs';
import { normalizeFeishuStepCardPanels } from './step-push-mode.mjs';

// Kept local because this opt-in renderer must not change shared/legacy text.
const LABELS = {
  zh: {
    running: '⚙️ 运行中', waiting: '⏳ 等待中', completed: '✅ 本轮回复已结束',
    stopped: '⏹ 已停止', failed: '❌ 执行失败', sealed: '🤖 助手',
    process: '执行过程', notes: '进度说明', reasoning: '推理过程', tools: '工具执行',
    omitted: '另有 {count} 条未显示', duration: '耗时', model: '模型',
    input: '输入', output: '输出', context: '上下文', window: '上下文窗口', rate: '速度',
  },
  en: {
    running: '⚙️ Running', waiting: '⏳ Waiting', completed: '✅ Reply ended',
    stopped: '⏹ Stopped', failed: '❌ Failed', sealed: '🤖 Assistant',
    process: 'Execution process', notes: 'Progress notes', reasoning: 'Reasoning', tools: 'Tool execution',
    omitted: '{count} more not shown', duration: 'Duration', model: 'Model',
    input: 'Input', output: 'Output', context: 'Context', window: 'Context window', rate: 'Rate',
  },
  ru: {
    running: '⚙️ Выполняется', waiting: '⏳ Ожидание', completed: '✅ Ответ завершён',
    stopped: '⏹ Остановлено', failed: '❌ Ошибка', sealed: '🤖 Ассистент',
    process: 'Ход выполнения', notes: 'Заметки о ходе работы', reasoning: 'Рассуждения', tools: 'Выполнение инструментов',
    omitted: 'Ещё {count} не показано', duration: 'Время', model: 'Модель',
    input: 'Вход', output: 'Выход', context: 'Контекст', window: 'Окно контекста', rate: 'Скорость',
  },
};
const TEMPLATES = Object.freeze({
  running: 'blue', waiting: 'orange', completed: 'green',
  stopped: 'red', failed: 'red', sealed: 'default',
});

function markdown(content, textSize) {
  return { tag: 'markdown', content, text_size: textSize };
}

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compactNumber(value) {
  return Number(value.toFixed(2)).toString();
}

// Model names are data, not Markdown or additional footer/status lines.
function inlineText(value) {
  return value.replace(/\s+/gu, ' ').trim()
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/gu, '\\$&');
}

/** Only display known, supplied measurements. Never estimate or infer usage/rate. */
function metricsText(metrics, labels) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return '';
  const parts = [];
  if (nonnegativeNumber(metrics.durationMs)) {
    const duration = metrics.durationMs < 1000
      ? `${compactNumber(metrics.durationMs)} ms`
      : `${compactNumber(metrics.durationMs / 1000)} s`;
    parts.push(`${labels.duration} ${duration}`);
  }
  if (typeof metrics.model === 'string' && metrics.model.trim()) {
    parts.push(`${labels.model} ${inlineText(metrics.model)}`);
  }
  if (tokenCount(metrics.inputTokens)) parts.push(`${labels.input} ${metrics.inputTokens} tokens`);
  if (tokenCount(metrics.outputTokens)) parts.push(`${labels.output} ${metrics.outputTokens} tokens`);
  const hasContext = tokenCount(metrics.contextTokens);
  const hasWindow = tokenCount(metrics.contextWindow) && metrics.contextWindow > 0;
  if (hasContext) {
    parts.push(`${labels.context} ${metrics.contextTokens}${hasWindow ? ` / ${metrics.contextWindow}` : ''} tokens`);
  } else if (hasWindow) {
    parts.push(`${labels.window} ${metrics.contextWindow} tokens`);
  }
  // The caller must provide a genuinely measured rate, not characters/time or
  // outputTokens/durationMs. In particular, this renderer never derives one.
  if (nonnegativeNumber(metrics.outputRate)) parts.push(`${labels.rate} ${compactNumber(metrics.outputRate)} tokens/s`);
  return parts.join(' · ');
}

function processContent(block, labels) {
  const lines = (Array.isArray(block.lines) ? block.lines : [])
    .filter(line => typeof line === 'string' && line.trim());
  // Actual reasoning may be supplied as a text block instead of line history.
  if (lines.length === 0 && block.kind === 'reasoning'
    && typeof block.text === 'string' && block.text.trim()) lines.push(block.text);
  if (lines.length === 0) return null;
  const content = [`**${labels[block.kind]}**`, ...lines];
  if (Number.isSafeInteger(block.omitted) && block.omitted > 0) {
    content.push(labels.omitted.replace('{count}', String(block.omitted)));
  }
  return markdown(content.join('\n'), 'small');
}

// Reuse the already-sanitized, truthfully labelled process lines. Bound the
// duplicate by serialized bytes as well as count so the splitter can budget it.
function toolSummary(blocks, labels) {
  const lines = blocks.filter(block => block?.kind === 'tools')
    .flatMap(block => Array.isArray(block.lines) ? block.lines : [])
    .filter(line => typeof line === 'string' && line.trim());
  if (!lines.length) return null;
  const selected = [];
  for (const line of lines.slice(0, 3)) {
    const chars = Array.from(line);
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = [...selected, chars.slice(0, mid).join('') + (mid < chars.length ? '…' : '')];
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= 1200) low = mid;
      else high = mid - 1;
    }
    if (!low) break;
    selected.push(chars.slice(0, low).join('') + (low < chars.length ? '…' : ''));
    if (low < chars.length) break;
  }
  if (!selected.length) return null;
  return markdown([`**${labels.tools}**`, ...selected].join('\n'), 'small');
}

function processPanel(elements, expanded, labels) {
  return {
    tag: 'collapsible_panel',
    expanded,
    background_color: 'grey-50',
    border: { color: 'grey', corner_radius: '8px' },
    padding: '8px 8px 8px 8px',
    header: {
      title: { tag: 'plain_text', content: labels.process },
      vertical_align: 'center',
      padding: '8px 8px 8px 8px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements,
  };
}

/**
 * Build an optional Hermes-style Feishu JSON 2.0 card; returns API `content`.
 *
 * @param {Array<{kind: string, text?: string, lines?: string[], omitted?: number}>} rawBlocks
 *   Message text is preserved verbatim and rendered first. Notes are progress
 *   notes, not reasoning; tools.lines must carry the caller's truthful states.
 * @param {object} [options]
 * @param {'running'|'waiting'|'completed'|'stopped'|'failed'|'sealed'} [options.status='running']
 * @param {{thinkingExpanded?: boolean, toolsExpanded?: boolean}} [options.stepCardPanels]
 * @param {{durationMs?: number, model?: string, inputTokens?: number,
 *   outputTokens?: number, contextTokens?: number, contextWindow?: number,
 *   outputRate?: number}} [options.metrics] Verified measurements only; outputRate
 *   is measured tokens/second. Missing/invalid values are not displayed.
 *
 * Capacity and table-budget splitting belong to the caller. This renderer does
 * not truncate answers, cap history, synthesize tool outcomes or estimate tokens.
 */
export function hermesCard(rawBlocks, { status = 'running', stepCardPanels, metrics } = {}) {
  const labels = LABELS[getImHostLanguage()] ?? LABELS.en;
  const state = Object.hasOwn(TEMPLATES, status) ? status : 'running';
  const panels = normalizeFeishuStepCardPanels(stepCardPanels);
  const elements = [];
  const process = [];
  for (const block of Array.isArray(rawBlocks) ? rawBlocks : []) {
    if (block?.kind === 'notes' || block?.kind === 'tools' || block?.kind === 'reasoning') {
      const content = processContent(block, labels);
      if (content) process.push(content);
    } else if ((block?.kind === 'message' || block?.kind == null)
      && typeof block?.text === 'string' && block.text.trim()) {
      elements.push(markdown(block.text, 'normal'));
    }
  }
  const summary = toolSummary(Array.isArray(rawBlocks) ? rawBlocks : [], labels);
  if (summary) elements.push(summary);
  if (process.length > 0) {
    // One flat panel, and user expansion choices survive every terminal state.
    elements.push(processPanel(process, panels.thinkingExpanded || panels.toolsExpanded, labels));
  }
  const footer = metricsText(metrics, labels);
  // Screenshot-oriented completion layout: DSH cannot reliably reproduce HFC's
  // native_reply predicate. Keep all other states visibly distinguished.
  if (state === 'completed') {
    elements.push({ tag: 'hr' });
    elements.push(markdown([labels.completed, footer].filter(Boolean).join(' · '), 'notation'));
  } else if (footer) {
    elements.push(markdown(footer, 'notation'));
  }
  // JSON 2.0 requires nonempty body elements; do not invent empty process/stats.
  if (elements.length === 0) elements.push(markdown(' ', 'normal'));
  return JSON.stringify({
    schema: '2.0',
    ...(state === 'completed' ? {} : { header: { title: { tag: 'plain_text', content: labels[state] }, template: TEMPLATES[state] } }),
    body: { elements },
  });
}
