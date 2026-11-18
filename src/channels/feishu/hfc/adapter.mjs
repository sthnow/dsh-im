// Display-only HFC adapter. No HFC authority registry, server or network client.
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeHfcRuntimeNamespace } from './runtime-namespace.mjs';
import { HfcWorker } from './worker-client.mjs';
export { HfcWorker, defaultHfcWorkerPath } from './worker-client.mjs';
import { HarnessApprovalQueue, harnessApprovalText, APPROVAL_SUBMIT_RESULT } from '../../shared/harness-approval.mjs';
import { harnessAnswerForQuestion, validHarnessQuestion } from '../../shared/harness-question.mjs';
const ROUTE_FIELDS = ['runtimeNamespace', 'botId', 'sessionId', 'chatId', 'senderId', 'turnId'];
const failure = (code) => Object.assign(new Error(code), { code });
const quietLogger = { warn() {}, error() {} };
const DEFAULT_BUDGETS = Object.freeze({ queue: 64, operations: 4096, inputBytes: 256 * 1024,
  retainedBytes: 2 * 1024 * 1024, events: 4096, replayEvents: 16384, interactionEntries: 64 });
function confirmed(receipt) {
  return receipt && receipt.accepted !== false && receipt.complete !== false
    && !['unknown', 'partial', 'failed', 'cancelled'].includes(receipt.status)
    && !(Array.isArray(receipt.remainingChunks) && receipt.remainingChunks.length)
    && !(Number.isInteger(receipt.failedChunkIndex) && receipt.failedChunkIndex >= 0)
    && (typeof receipt.messageId === 'string' && receipt.messageId.length > 0
      || Array.isArray(receipt.providerMessageIds) && receipt.providerMessageIds.length > 0
        && receipt.providerMessageIds.every((id) => typeof id === 'string' && id.length > 0));
}

// Harness metrics are complete replacement snapshots, never increments. Keep
// them local until terminal: upstream failure metrics merge and cannot be cleared.
function terminalMetrics(update) {
  const data = {}, tokens = {};
  for (const [source, target] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens']]) {
    if (Number.isSafeInteger(update[source]) && update[source] >= 0) tokens[target] = update[source];
  }
  if (Object.keys(tokens).length) data.tokens = tokens;
  const rate = update.rate;
  if (rate?.basis === 'decode' && typeof rate.output_tps === 'number'
    && Number.isFinite(rate.output_tps) && rate.output_tps > 0 && rate.output_tps < 1e6) {
    data.rate = { output_tps: rate.output_tps, basis: 'decode' };
  }
  const context = update.context;
  if (Number.isSafeInteger(context?.used_tokens) && context.used_tokens >= 0
    && Number.isSafeInteger(context?.max_tokens) && context.max_tokens > 0) {
    data.context = { used_tokens: context.used_tokens, max_tokens: context.max_tokens };
  }
  for (const key of ['model', 'provider']) {
    if (typeof update[key] === 'string' && update[key].trim()) data[key] = update[key].trim();
  }
  return data;
}

function walk(value, callback) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, callback);
}

/** One adapter owns one display-only worker. Authority always remains in DSH closures. */
export class DshHfcAdapter {
  constructor({ worker, route, sink, signal, budgets = {}, minRenderIntervalMs = 500, minPatchIntervalMs = 250,
    now = () => performance.now(), sleep = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }),
    approvalTimeoutMs = 3_600_000, interactionTimeoutMs = 300_000 } = {}) {
    for (const key of ROUTE_FIELDS) if (typeof route?.[key] !== 'string' || !route[key].trim()) throw failure('invalid-route');
    if (!normalizeHfcRuntimeNamespace(route.runtimeNamespace)) throw failure('invalid-runtime-namespace');
    if (!worker || typeof worker.event !== 'function') throw failure('invalid-worker');
    if (typeof sink?.create !== 'function' || typeof sink?.patch !== 'function' || typeof sink?.native !== 'function') throw failure('invalid-sink');
    this.worker = worker; this.route = Object.freeze({ ...route }); this.sink = sink; this.signal = signal;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    for (const n of Object.values(this.budgets)) if (!Number.isSafeInteger(n) || n < 1) throw failure('invalid-adapter-budget');
    if (!Number.isSafeInteger(minRenderIntervalMs) || minRenderIntervalMs < 0) throw failure('invalid-render-interval');
    if (!Number.isSafeInteger(minPatchIntervalMs) || minPatchIntervalMs < 0) throw failure('invalid-patch-interval');
    if (typeof now !== 'function' || typeof sleep !== 'function') throw failure('invalid-patch-clock');
    this.minRenderIntervalMs = minRenderIntervalMs; this.lastRenderedAt = -Infinity;
    this.minPatchIntervalMs = minPatchIntervalMs; this.now = now; this.sleep = sleep; this.lastPatchAt = null;
    this.queued = 0; this.operations = 0; this.replayEvents = 0;
    this.interactionTimeoutMs = interactionTimeoutMs;
    this.approvals = new HarnessApprovalQueue({ label: 'HFC-offline', logger: quietLogger, approvalTimeoutMs });
    this.entries = new Map(); this.bindings = new Map(); this.records = []; this.textRecords = new Map();
    this.interactionRails = new Map();
    this.created = false; this.started = false; this.closed = false; this.finished = false; this.sequence = 0;
    this.tail = Promise.resolve(); this.lastResult = null;
    // State application stays FIFO/budgeted; network publication has only one
    // in-flight card and one latest unsent draft, regardless of tool volume.
    this.publishTail = Promise.resolve(); this.pendingDraft = null; this.publisher = null;
    this.metrics = {}; this.observationStarted = false; this.observationEnded = false;
    this.abort = () => { this.pendingDraft = null; this.publisher?.abort(); this.bindings.clear(); for (const entry of this.entries.values()) { entry.inactive = true; clearTimeout(entry.timer); } };
    signal?.addEventListener('abort', this.abort, { once: true });
  }
  _serial(fn, terminal = false) {
    if (!terminal && (this.queued >= this.budgets.queue || ++this.operations > this.budgets.operations)) {
      this.displayFault = failure('adapter-queue-budget');
      void this.worker.close().catch(() => {});
      return Promise.reject(this.displayFault);
    }
    this.queued++;
    const task = this.tail.then(fn).catch((error) => {
      if (/^(worker|adapter-.*budget|input_too_large)/.test(error?.code ?? '')) {
        this.displayFault = error; void this.worker.close().catch(() => {});
      }
      throw error;
    }).finally(() => { this.queued--; });
    this.tail = task.catch(() => {}); return task;
  }
  _input(value) {
    let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw failure('invalid-input'); }
    if (bytes > this.budgets.inputBytes) throw failure('adapter-input-budget');
  }
  _remember(record) {
    if (this.records.length + 1 > this.budgets.events) throw failure('adapter-event-budget');
    const bytes = Buffer.byteLength(JSON.stringify([...this.records, record]));
    if (bytes > this.budgets.retainedBytes) throw failure('adapter-retained-budget');
    this.records.push(record);
  }
  _displayLive() { if (this.displayFault) throw this.displayFault; }
  async _native(text) {
    if (this.nativeAttempted) throw failure('native-already-attempted');
    if (this.deliveryFault) throw failure('delivery-state-unknown');
    this.nativeAttempted = true;
    try {
      const receipt = await this.sink.native(text);
      if (!confirmed(receipt)) throw failure('native-unconfirmed');
      return receipt;
    } catch (error) { this.deliveryFault = true; throw error; }
  }
  _live() { if (this.closed || this.signal?.aborted) throw failure('adapter-closed'); }
  _checkTurn(update) { if (update.turn !== undefined && String(update.turn) !== this.route.turnId) throw failure('wrong-turn'); }
  _event(name, data) {
    return { schema_version: '1', event: name, conversation_id: this.route.sessionId, message_id: this.route.turnId,
      chat_id: this.route.chatId, platform: 'feishu', turn_id: this.route.turnId,
      sequence: ++this.sequence, created_at: Date.now() / 1000,
      data: { profile_id: this.route.runtimeNamespace, bot_id: this.route.botId, ...data } };
  }
  async _render(result, terminalText, publicationSignal) {
    if (result.accepted !== true) throw failure('hfc-event-rejected');
    if (!['card', 'deferred_native', 'native'].includes(result.disposition) || result.segments?.length) throw failure('unsupported-disposition');
    if (result.disposition === 'native' && typeof terminalText !== 'string') throw failure('nonterminal-native');
    this._live(); publicationSignal?.throwIfAborted();
    const writeSignal = publicationSignal && this.signal ? AbortSignal.any([publicationSignal, this.signal]) : publicationSignal ?? this.signal;
    if (this.deliveryFault) throw this.deliveryError ?? failure('delivery-state-unknown');
    // Draft publication is single-flight; receipt barriers exclude interactions
    // and terminal writes from that publisher. Space actual PATCH starts for
    // both paths; never discard the terminal flush.
    if (this.created && this.lastPatchAt !== null) {
      let remaining = this.minPatchIntervalMs - (this.now() - this.lastPatchAt);
      while (remaining > 0) {
        await this.sleep(Math.ceil(remaining), writeSignal);
        this._live(); publicationSignal?.throwIfAborted();
        remaining = this.minPatchIntervalMs - (this.now() - this.lastPatchAt);
      }
      this._live();
    }
    this._live(); publicationSignal?.throwIfAborted();
    if (this.deliveryFault) throw this.deliveryError ?? failure('delivery-state-unknown');
    try {
      if (this.created) this.lastPatchAt = this.now();
      const receipt = !this.created ? await this.sink.create(result.card) : await this.sink.patch(result.card);
      if (!confirmed(receipt)) throw failure('card-delivery-unconfirmed');
      this.mainMessageId ??= receipt.messageId ?? receipt.providerMessageIds?.[0];
      this.created = true;
    } catch (error) { this.deliveryFault = true; this.deliveryError = error; throw error; }
    // Upstream native.primary_text defaults to empty in v5.0.25. Authoritative
    // DSH terminal text is passed explicitly; never infer body from handoff card.
    if (result.disposition === 'native') await this._native(terminalText);
    this.lastRenderedAt = this.now(); this.lastResult = result;
    await this._renderInteraction(result);
    return result;
  }
  async _renderInteraction(result) {
    const card = result.interaction_card;
    const interaction = result.summary?.interaction;
    // Optional only for non-interactive/older worker fixtures. Never put controls
    // onto the main message when the separate rail contract is absent.
    if (!card || !interaction) return;
    const id = interaction.interaction_id;
    if (typeof id !== 'string' || !id) throw failure('invalid-interaction-render');
    const previous = this.interactionRails.get(id);
    const encoded = JSON.stringify(card);
    if (previous?.encoded === encoded) return;
    const pending = interaction.status === 'pending';
    if (!previous && !pending) return;
    if (typeof this.sink.createInteraction !== 'function' || typeof this.sink.patchInteraction !== 'function') throw failure('interaction-sink-required');
    // A terminal update revokes controls before its I/O; a failed PATCH cannot
    // make a committed DSH response executable again.
    for (const [token, binding] of this.bindings) if (binding.displayId === id) this.bindings.delete(token);
    this._live();
    try {
      if (previous && this.lastPatchAt !== null) {
        let remaining = this.minPatchIntervalMs - (this.now() - this.lastPatchAt);
        while (remaining > 0) {
          await this.sleep(Math.ceil(remaining), this.signal); this._live();
          remaining = this.minPatchIntervalMs - (this.now() - this.lastPatchAt);
        }
      }
      if (previous) this.lastPatchAt = this.now();
      const receipt = previous
        ? await this.sink.patchInteraction(id, previous.messageId, card)
        : await this.sink.createInteraction(id, card);
      if (!confirmed(receipt)) throw failure('interaction-delivery-unconfirmed');
      const messageId = receipt.messageId ?? receipt.providerMessageIds?.[0];
      if (previous && previous.messageId !== messageId) throw failure('interaction-message-changed');
      if (!previous && (messageId === this.mainMessageId || [...this.interactionRails.values()].some(rail => rail.messageId === messageId))) throw failure('interaction-message-reused');
      this._live();
      this.interactionRails.set(id, { messageId, encoded, ...(previous ? { patchedAt: this.now() } : {}) });
      if (pending) this._bindInteraction(card, id, messageId);
    } catch (error) {
      this.deliveryFault = true; this.deliveryError = error; this.bindings.clear(); throw error;
    }
  }
  _bindInteraction(card, displayId, messageId) {
    walk(card, (node) => {
      const v = node.value;
      if (v?.hfc_action === 'interaction.select' && typeof v.token === 'string') {
        const entry = [...this.entries.values()].find((e) => e.displayId === v.interaction_id && !e.inactive);
        if (!entry) return;
        entry.record.data.callback_token = v.token;
        this.bindings.set(v.token, { entry, displayId, messageId, values: [...(this.bindings.get(v.token)?.values ?? []), { ...v }], names: this.bindings.get(v.token)?.names ?? [] });
      }
      if (typeof node.name === 'string' && /^(hfc_other_|hfc_confirm_)/.test(node.name)) {
        const token = node.name.replace(/^(hfc_other_|hfc_confirm_)/, '');
        const entry = [...this.entries.values()].find((e) => e.record?.data.callback_token === token && !e.inactive);
        if (!entry) return;
        const binding = this.bindings.get(token) ?? { entry, displayId, messageId, values: [], names: [] };
        binding.names.push(node.name); this.bindings.set(token, binding);
      }
    });
    // A form-only clarify has no ordinary choice button; recover its upstream-generated token by name.
    walk(card, (node) => {
      if (typeof node.name !== 'string' || !/^(hfc_other_|hfc_confirm_)/.test(node.name)) return;
      const token = node.name.replace(/^(hfc_other_|hfc_confirm_)/, '');
      if (this.bindings.has(token)) return;
      const id = displayId;
      const entry = [...this.entries.values()].find((e) => e.displayId === id && !e.inactive);
      if (!entry) return;
      entry.record.data.callback_token = token;
      this.bindings.set(token, { entry, displayId, messageId, values: [], names: [node.name] });
    });
  }
  async _publicationBarrier() {
    // Supersede unsent drafts, never an already-started network request. The
    // state tail is held by the caller, so worker tokens cannot be reset while
    // an interaction result is being published and its bindings installed.
    this.pendingDraft = null;
    this.publisher?.abort();
    await this.publishTail;
    if (this.publishError) throw this.publishError;
    this._live();
    if (this.deliveryFault) throw this.deliveryError ?? failure('delivery-state-unknown');
  }
  async _emit(name, data, terminalText) {
    if (name !== 'tool.updated') await this._publicationBarrier();
    this._live(); this._displayLive(); const event = this._event(name, data); this._remember(event);
    const result = await this.worker.event(event);
    return name === 'tool.updated' ? this._draftResult(result) : this._render(result, terminalText);
  }
  _draftResult(result) {
    if (result.accepted !== true) throw failure('hfc-event-rejected');
    if (!['card', 'deferred_native'].includes(result.disposition) || result.segments?.length) throw failure('unsupported-disposition');
    if (this.deliveryFault) throw this.deliveryError ?? failure('delivery-state-unknown');
    // Pending interactions own callback tokens: publish their state under the
    // same strong barrier as the initial interaction card, never reset in-flight.
    if ([...this.entries.values()].some(entry => !entry.inactive)) {
      return this._publicationBarrier().then(() => this._render(result));
    }
    this.pendingDraft = result;
    if (!this.publisher) {
      const controller = new AbortController(); this.publisher = controller;
      this.publishTail = (async () => {
        // Yield one task boundary so a synchronous burst applies all FIFO state
        // first. The timer is abortable: finish/interaction must not wait 500ms
        // for a draft it is about to replace with an authoritative card.
        while (this.pendingDraft) {
          const remaining = Math.max(0, this.minRenderIntervalMs - (this.now() - this.lastRenderedAt));
          await delay(Math.ceil(remaining), undefined, { signal: controller.signal });
          this._live();
          const latest = this.pendingDraft; this.pendingDraft = null;
          if (latest) await this._render(latest, undefined, controller.signal);
        }
      })().catch(error => {
        if (controller.signal.aborted && error?.name === 'AbortError') return;
        // Publication is awaited by the next barrier/close. Retain the original
        // error; no unknown send is retried or converted to a native fallback.
        this.publishError = error;
      }).finally(() => { if (this.publisher === controller) this.publisher = null; });
    }
    return { ...result, coalesced: true };
  }
  async _rebuild() {
    // Display reset only. Never recreate pending DSH authority or send a second create.
    this._displayLive();
    if ((this.replayEvents += this.records.length) > this.budgets.replayEvents) throw failure('adapter-replay-budget');
    await this.worker.reset(); let result;
    for (const record of this.records) result = await this.worker.event(record);
    if (result) return this._draftResult(result);
  }
  _observeEnd(at) {
    if (this.observationEnded) return;
    this.observationEnded = true;
    // Local monotonic observation of the whole turn (including waits), not
    // Host event wall time or a generation window. Never derive tok/s from it.
    if (typeof at !== 'number' || !Number.isFinite(at)
      || typeof this.observationStart !== 'number' || !Number.isFinite(this.observationStart)) return;
    const elapsed = (at - this.observationStart) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) this.duration = elapsed;
  }
  async start() {
    if (!this.observationStarted) { this.observationStarted = true; this.observationStart = this.now(); }
    return this._serial(async () => {
      this._live(); if (this.started) return this.lastResult;
      await this.worker.start(); this.started = true;
      return this._emit('message.started', {});
    });
  }
  onUpdate(update) {
    const endedAt = update?.type === 'turn-end' ? this.now() : undefined;
    try { this._input(update); } catch (error) { this.displayFault = error; void this.worker.close().catch(() => {}); return Promise.reject(error); }
    return this._serial(async () => {
      this._live(); if (!this.started) throw failure('adapter-not-started'); if (this.finished) return { accepted: false, reason: 'finished' };
      this._displayLive(); this._checkTurn(update);
      if ([...this.entries.values()].some(entry => !entry.inactive)) await this._publicationBarrier();
      if (update.type === 'text' || update.type === 'assistant-message') {
        if (typeof update.text !== 'string') throw failure('invalid-text');
        const key = `text:${update.step ?? 'unknown'}`; const existing = this.textRecords.get(key);
        if (existing?.data.text === update.text) return this.lastResult;
        if (existing) {
          const before = existing.data.text; existing.data.text = update.text;
          if (Buffer.byteLength(JSON.stringify(this.records)) > this.budgets.retainedBytes) { existing.data.text = before; throw failure('adapter-retained-budget'); }
          return this._rebuild();
        }
        const record = this._event('answer.delta', { text: update.text }); this._remember(record); this.textRecords.set(key, record);
        return this._draftResult(await this.worker.event(record));
      }
      if (update.type === 'reasoning') {
        if (typeof update.text !== 'string') throw failure('invalid-reasoning');
        const key = `reasoning:${update.step ?? 'unknown'}`; const existing = this.textRecords.get(key);
        if (existing?.data.text === update.text) return this.lastResult;
        if (existing) {
          const before = existing.data.text; existing.data.text = update.text;
          if (Buffer.byteLength(JSON.stringify(this.records)) > this.budgets.retainedBytes) { existing.data.text = before; throw failure('adapter-retained-budget'); }
          return this._rebuild();
        }
        const record = this._event('thinking.delta', { text: update.text, mode: 'append_block' }); this._remember(record); this.textRecords.set(key, record);
        return this._draftResult(await this.worker.event(record));
      }
      if (update.type === 'tool' || update.type === 'tool-result') {
        if (typeof update.callId !== 'string' || !update.callId) throw failure('missing-tool-call-id');
        return this._emit('tool.updated', { tool_id: update.callId, call_id: update.callId, name: update.name ?? update.toolName ?? update.callId,
          status: update.type === 'tool' ? 'running' : update.isError ? 'failed' : 'completed',
          detail: update.type === 'tool' ? update.arguments ?? '' : update.text ?? update.error ?? '' });
      }
      if (update.type === 'metrics') { this.metrics = terminalMetrics(update); return { accepted: true }; }
      if (update.type === 'turn-end') { this._observeEnd(endedAt); this.turnReason = update.reason; return { accepted: true }; }
      if (update.type === 'turn-start' || update.type === 'status') return { accepted: true };
      throw failure('unsupported-update');
    });
  }
  onInteraction(interaction) {
    try { this._input(interaction?.payload); } catch (error) { return Promise.reject(error); }
    return this._serial(async () => {
      await this._publicationBarrier();
      this._live(); this._displayLive();
      if (!this.entries.has(interaction?.interactionId) && this.entries.size >= this.budgets.interactionEntries) throw failure('adapter-interaction-budget');
      if (this.finished || interaction?.sessionId !== this.route.sessionId || interaction.payload?.sessionId !== this.route.sessionId
        || typeof interaction.respond !== 'function' || typeof interaction.rpcId !== 'string' || typeof interaction.interactionId !== 'string') throw failure('invalid-interaction');
      if (interaction.kind === 'approval') {
        if (!harnessApprovalText(interaction.payload, { toolCall: interaction.toolCall })) throw failure('incomplete-approval-scope');
        return this.approvals.handleRequested(interaction, {
          key: JSON.stringify(this.route), actor: this.route.senderId, send: async () => {},
          validate: async () => { this._live(); },
          render: async (pending) => {
            const entry = { kind: 'approval', interaction: pending.interaction, pending, displayId: pending.approvalId, inactive: false,
              expiresAt: Date.now() + this.interactionTimeoutMs };
            this.entries.set(interaction.interactionId, entry);
            const data = { interaction_id: entry.displayId, kind: 'approval', prompt: pending.text, allow_custom_input: false,
              options: [{ label: '批准本次', value: 'allowed-once' }, { label: '拒绝', value: 'rejected' }] };
            const record = this._event('interaction.requested', data); entry.record = record; this._remember(record);
            await this._render(await this.worker.event(record));
          },
          onResolved: async (text, outcome) => {
            const entry = this.entries.get(interaction.interactionId); if (!entry || entry.inactive) return true;
            entry.inactive = true;
            await this._emit(outcome === 'allowed-once' || outcome === 'rejected' ? 'interaction.completed' : 'interaction.failed',
              { interaction_id: entry.displayId, choice: outcome, choice_label: text, error: outcome });
            return true;
          },
        });
      }
      if (interaction.kind !== 'question' || !Array.isArray(interaction.payload.questions) || !interaction.payload.questions.length
        || interaction.payload.questions.some((q) => !validHarnessQuestion(q))) throw failure('invalid-question');
      if (interaction.recovered) {
        await interaction.respond({ ok: false, error: { code: 'cancelled', message: 'Recovered question safely cancelled', details: {} } }); return { accepted: false, reason: 'recovered' };
      }
      const existing = this.entries.get(interaction.interactionId);
      if (existing) { if (!existing.inactive) existing.interaction = interaction; return { accepted: false, reason: 'duplicate' }; }
      if ([...this.entries.values()].some((e) => e.kind === 'question' && !e.inactive)) throw failure('question-already-pending');
      const entry = { kind: 'question', interaction, index: 0, answers: [], inactive: false, expiresAt: Date.now() + this.interactionTimeoutMs };
      this.entries.set(interaction.interactionId, entry);
      const result = await this._presentQuestion(entry);
      entry.timer = setTimeout(() => {
        void this._serial(async () => {
          if (entry.inactive || this.closed || this.closing || this.signal?.aborted || this.deliveryFault) return;
          entry.inactive = true; this.bindings.clear();
          await this._emit('interaction.failed', { interaction_id: entry.displayId, error: 'interaction-expired' });
        }).catch(() => {});
      }, Math.max(0, entry.expiresAt - Date.now()));
      entry.timer.unref?.();
      return result;
    });
  }
  async _presentQuestion(entry) {
    const question = entry.interaction.payload.questions[entry.index];
    entry.displayId = `${entry.interaction.interactionId}:q:${entry.index}`;
    const record = this._event('interaction.requested', { interaction_id: entry.displayId, kind: 'clarify',
      prompt: question.question, description: [question.header, question.detail].filter(Boolean).join('\n'),
      options: (question.options ?? []).map((option) => ({ label: option.label, value: option.label })),
      multi_select: question.multiSelect === true, allow_custom_input: true });
    entry.record = record; this._remember(record); return this._render(await this.worker.event(record));
  }
  onInteractionResolved(resolution) {
    return this._serial(async () => {
      await this._publicationBarrier();
      if (resolution.sessionId !== this.route.sessionId) throw failure('wrong-session');
      if (resolution.kind === 'approval') return this.approvals.handleResolved(resolution);
      const entry = this.entries.get(resolution.interactionId);
      if (!entry || entry.inactive) return { accepted: false, reason: 'not-pending' };
      entry.inactive = true; clearTimeout(entry.timer);
      return this._emit('interaction.failed', { interaction_id: entry.displayId, error: 'resolved-on-another-client' });
    });
  }
  onAction({ actor, messageId, value, formValue, name } = {}) {
    try { this._input({ actor, messageId, value, formValue, name }); } catch { return Promise.resolve({ accepted: false, reason: 'action-budget' }); }
    return this._serial(async () => {
      if (this.closed || this.closing || this.signal?.aborted || this.finished) return { accepted: false, reason: 'closed' };
      if (this.deliveryFault || this.displayFault) return { accepted: false, reason: 'display-unavailable' };
      await this._publicationBarrier();
      if (ROUTE_FIELDS.some((key) => actor?.[key] !== this.route[key])) return { accepted: false, reason: 'wrong-actor-or-route' };
      try { this._input({ value, formValue, name }); } catch { return { accepted: false, reason: 'action-budget' }; }
      const emptyValue = value == null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
      if (!emptyValue && value?.profile_id !== this.route.runtimeNamespace) return { accepted: false, reason: 'wrong-runtime-namespace' };
      const formToken = typeof name === 'string' && /^(hfc_other_|hfc_confirm_)/.test(name) ? name.replace(/^(hfc_other_|hfc_confirm_)/, '') : null;
      if (!formToken && emptyValue) return { accepted: false, reason: 'missing-value' };
      if (formToken && !emptyValue && value.token !== undefined && value.token !== formToken) return { accepted: false, reason: 'bad-form-token' };
      const binding = this.bindings.get(value?.token ?? formToken); const entry = binding?.entry;
      if (!entry || entry.inactive) return { accepted: false, reason: 'not-pending' };
      if (typeof messageId !== 'string' || binding.messageId !== messageId) return { accepted: false, reason: 'wrong-message' };
      if (Date.now() >= entry.expiresAt) {
        entry.inactive = true; this.bindings.clear();
        await this._emit('interaction.failed', { interaction_id: entry.displayId, error: 'interaction-expired' });
        return { accepted: false, reason: 'expired' };
      }
      let answerText; let structuredAnswer;
      if (formToken) {
        if (!binding.names.includes(name) || entry.kind !== 'question') return { accepted: false, reason: 'bad-form' };
        const q = entry.interaction.payload.questions[entry.index];
        const custom = formValue?.hfc_other;
        if (custom !== undefined && typeof custom !== 'string') return { accepted: false, reason: 'invalid-custom' };
        const selected = name.startsWith('hfc_confirm_') ? (formValue?.hfc_multi ?? []) : [];
        const labels = new Set((q.options ?? []).map((o) => o.label));
        if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string' || !labels.has(label))
          || new Set(selected).size !== selected.length || (q.multiSelect !== true && selected.length > 1)) return { accepted: false, reason: 'invalid-option' };
        if (!selected.length && !custom?.trim()) return { accepted: false, reason: 'empty-answer' };
        if (q.multiSelect !== true && selected.length && custom?.trim()) return { accepted: false, reason: 'single-select-conflict' };
        // Native forms are already structured: never flatten labels through a delimiter parser.
        structuredAnswer = { id: q.id, selected: [...selected], ...(custom?.trim() ? { custom } : {}) };
        answerText = [...selected, ...(custom?.trim() ? [custom] : [])].join('、');
      } else {
        if (!binding.values.some((v) => v.hfc_action === value.hfc_action && v.interaction_id === value.interaction_id && v.choice === value.choice)) return { accepted: false, reason: 'bad-token-or-choice' };
        answerText = value.choice;
      }
      if (entry.kind === 'approval') {
        const result = await this.approvals.submitByApprovalId(entry.pending.approvalId, answerText, { actor: actor.senderId, detailed: true });
        return { accepted: result === APPROVAL_SUBMIT_RESULT.SUBMITTED, reason: result };
      }
      const question = entry.interaction.payload.questions[entry.index];
      const answer = structuredAnswer ?? (formToken ? harnessAnswerForQuestion(question, answerText)
        : { id: question.id, selected: [answerText] });
      const final = entry.index + 1 === entry.interaction.payload.questions.length;
      if (final) {
        try {
          const receipt = await entry.interaction.respond({ ok: true, value: { sessionId: this.route.sessionId, answer: { answers: [...entry.answers, answer] } } });
          if (receipt?.accepted === false) throw failure('interaction-not-pending');
          if (receipt?.accepted !== true) throw failure('interaction-response-unconfirmed');
        } catch (error) {
          if (error?.code === 'interaction-not-pending') { entry.inactive = true; this.bindings.clear(); }
          return { accepted: false, reason: error?.code === 'interaction-not-pending' ? 'not-pending' : 'retryable' };
        }
      }
      // Commit local replay protection immediately after the authoritative RPC,
      // before any display I/O that may fail. A stale card must never submit twice.
      const resolvedDisplayId = entry.displayId;
      this.bindings.clear(); entry.answers.push(answer); entry.index++;
      if (final) { entry.inactive = true; clearTimeout(entry.timer); }
      await this._emit('interaction.completed', { interaction_id: resolvedDisplayId, choice: answerText, choice_label: answerText });
      if (!final) await this._presentQuestion(entry);
      return { accepted: true, submitted: final };
    });
  }
  finish({ text, failed = false, interrupted = false } = {}) {
    const endedAt = this.now();
    return this._serial(async () => {
      this._live(); if (this.finished) return this.lastResult;
      if (this.terminalAttempted) throw failure('terminal-already-attempted');
      if ([...this.entries.values()].some((entry) => !entry.inactive)) throw failure('interaction-still-pending');
      if (typeof text !== 'string') throw failure('invalid-final-text');
      this.terminalAttempted = true; this._observeEnd(endedAt);
      const reason = this.turnReason?.kind ?? this.turnReason;
      const isFailure = failed || interrupted || reason === 'error' || reason === 'aborted' || reason === 'cancelled';
      let result;
      try {
        const metrics = { ...this.metrics, ...(this.duration === undefined ? {} : { duration: this.duration }) };
        // Failure adoption has a different fixed upstream contract. Do not
        // leak success-only display fields or change that consumer here.
        if (isFailure) { delete metrics.rate; delete metrics.context; }
        // Pinned upstream failure adoption ignores provider; preserve a known
        // route without inventing one, and do not change the terminal event kind.
        if (isFailure && metrics.model && metrics.provider && !metrics.model.startsWith(`${metrics.provider}/`)) {
          metrics.model = `${metrics.provider}/${metrics.model}`;
        }
        result = await this._emit(isFailure ? 'message.failed' : 'message.completed',
          { ...metrics, ...(isFailure ? { error: text } : { answer: text }) }, text);
      } catch (error) {
        // A poisoned renderer/budget may hand full terminal text to the same DSH
        // owner. A delivery error/unknown outcome must NEVER create another send.
        if (this.deliveryFault || this.nativeAttempted || !/^(worker|adapter-.*budget|input_too_large|hfc-worker)/.test(error?.code ?? '')) throw error;
        await this._native(text);
        result = { accepted: true, disposition: 'native', fallback: true };
      }
      this.finished = true; this.bindings.clear(); this.lastResult = result; return result;
    }, true);
  }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.bindings.clear();
    this.closeTask = (async () => {
      // Let an already-authorized in-flight resolver settle; queued actions see closing.
      await this.tail;
      this.pendingDraft = null; this.publisher?.abort(); await this.publishTail;
      this.signal?.removeEventListener('abort', this.abort);
      for (const entry of this.entries.values()) { entry.inactive = true; clearTimeout(entry.timer); }
      await this.approvals.closeRoute(JSON.stringify(this.route));
      this.closed = true; await this.worker.close();
    })();
    return this.closeTask;
  }
}
