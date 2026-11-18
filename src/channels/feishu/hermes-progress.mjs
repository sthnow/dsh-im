/** Display-only state for the opt-in Hermes card; never makes execution decisions. */
export class HermesCardProgress {
  constructor(now = Date.now) {
    this.now = now;
    this.startedAt = now();
    this.tools = new Map();
    this.notes = [];
    this.noteSteps = [];
    this.noteOrder = [];
    this.reasoning = new Map();
    this.reasoningOrder = new Map();
    this.order = 0;
    this.draftOrder = 0;
    this.step = null;
    this.draft = '';
    this.metrics = {};
    this.status = 'running';
  }

  consume(update) {
    if (update.type === 'metrics') {
      // A snapshot, not a delta: absent totals must also remove an older value.
      this.metrics = { ...update };
      delete this.metrics.type;
    } else if (update.type === 'reasoning') {
      if (typeof update.text === 'string' && update.text.trim()) {
        const key = update.step ?? this.step ?? 0;
        this.reasoning.set(key, update.text);
        this.reasoningOrder.set(key, ++this.order);
      }
    } else if (update.type === 'text' || update.type === 'assistant-message') {
      if (typeof update.text !== 'string') return;
      // Older steps may be replayed or finalized after a newer draft arrives.
      // Update their archived note in place, never switch the active draft back.
      const older = Number.isSafeInteger(update.step) && Number.isSafeInteger(this.step) && update.step < this.step;
      if (older) {
        const index = this.noteSteps.lastIndexOf(update.step);
        if (index !== -1) {
          if (!update.text.trim() && update.type === 'text') {
            this.notes.splice(index, 1);
            this.noteSteps.splice(index, 1);
            this.noteOrder.splice(index, 1);
          } else if (update.text.trim()) {
            this.notes[index] = update.text.slice(0, 1200);
            this.noteOrder[index] = ++this.order;
          }
        } else if (update.type === 'assistant-message' && update.text.trim()) {
          // The earlier step may never have had a visible draft to archive.
          this.notes.push(update.text.slice(0, 1200));
          this.noteSteps.push(update.step);
          this.noteOrder.push(++this.order);
          while (this.notes.length > 12) { this.notes.shift(); this.noteSteps.shift(); this.noteOrder.shift(); }
        }
        return;
      }
      // Empty text is an explicit retraction of a failed attempt's draft.
      if (!update.text.trim()) {
        if (update.type === 'text' && (update.step === undefined || update.step === this.step)) this.draft = '';
        return;
      }
      if (this.step !== null && update.step !== undefined && update.step !== this.step) this.archiveDraft();
      this.step = update.step ?? this.step;
      this.draft = update.text;
      this.draftOrder = ++this.order;
    } else if (update.type === 'tool') {
      this.archiveDraft();
      const id = update.callId ?? `unknown-${this.tools.size}`;
      const name = String(update.name ?? 'tool');
      let summary = '';
      try {
        const args = JSON.parse(update.arguments ?? '{}');
        summary = args.description ?? args.question ?? args.query ?? args.file_path ?? args.path ?? '';
      } catch { /* Unknown arguments are not invented or exposed as a result. */ }
      this.tools.set(id, { name, summary: String(summary).replace(/\s+/g, ' ').slice(0, 180), status: 'running', order: ++this.order });
    } else if (update.type === 'tool-result') {
      const tool = this.tools.get(update.callId);
      if (!tool) return; // Never attribute an unmatched result to the latest call.
      tool.status = update.isError || update.error ? 'failed' : 'completed';
      tool.error = update.error ? String(update.error).slice(0, 400) : '';
      tool.order = ++this.order;
    } else if (update.type === 'turn-end') {
      const reason = update.reason?.kind ?? update.reason;
      this.status = reason === 'completed' ? 'completed'
        : reason === 'error' ? 'failed' : 'stopped';
      this.closeTools();
    }
    // Bounded process history does not truncate the answer or canonical log.
    while (this.notes.length > 12) { this.notes.shift(); this.noteSteps.shift(); this.noteOrder.shift(); }
    while (this.reasoning.size > 12) {
      const key = this.reasoning.keys().next().value;
      this.reasoning.delete(key);
      this.reasoningOrder.delete(key);
    }
    while (this.tools.size > 30) this.tools.delete(this.tools.keys().next().value);
  }

  archiveDraft() {
    if (this.draft.trim()) {
      this.notes.push(this.draft.slice(0, 1200));
      this.noteSteps.push(this.step);
      this.noteOrder.push(this.draftOrder);
    }
    this.draft = '';
  }

  closeTools() {
    for (const tool of this.tools.values()) if (tool.status === 'running') tool.status = 'stopped';
  }

  finish(status) {
    this.status = status;
    this.closeTools();
    this.metrics.durationMs = Math.max(0, this.now() - this.startedAt);
  }

  blocks() {
    // No reliable timestamp is supplied: use observation order, including updates
    // to an existing item's current state, as a deterministic event ordering.
    const entries = this.notes.map((line, i) => ({ kind: 'notes', line, order: this.noteOrder[i] }));
    for (const [key, text] of this.reasoning) {
      entries.push({ kind: 'reasoning', line: text.slice(-1200), order: this.reasoningOrder.get(key) });
    }
    for (const tool of this.tools.values()) {
      const icon = { running: '⏳', completed: '✅', failed: '❌', stopped: '⏹' }[tool.status];
      entries.push({ kind: 'tools', order: tool.order, line: `${icon} ${tool.name}${tool.summary ? ` — ${tool.summary}` : ''}${tool.error ? `\n${tool.error}` : ''}` });
    }
    entries.sort((a, b) => b.order - a.order);
    // Keep the existing per-kind byte budget, retaining the newest entries.
    const bytes = new Map(), omitted = new Map(), selected = [];
    for (const entry of entries) {
      let size = Buffer.byteLength(JSON.stringify(entry.line), 'utf8');
      const used = bytes.get(entry.kind) ?? 0;
      // A single oversized newest entry must not hide the whole category (and
      // its omitted count). Clip display text only, on Unicode boundaries.
      if (used === 0 && size > 6000) {
        const chars = Array.from(entry.line);
        let low = 0, high = chars.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join('') + '…'), 'utf8') <= 6000) low = mid;
          else high = mid - 1;
        }
        entry.line = chars.slice(0, low).join('') + '…';
        size = Buffer.byteLength(JSON.stringify(entry.line), 'utf8');
      }
      if (used + size > 6000 || omitted.has(entry.kind)) {
        omitted.set(entry.kind, (omitted.get(entry.kind) ?? 0) + 1);
      } else {
        bytes.set(entry.kind, used + size);
        selected.push(entry);
      }
    }
    const blocks = [];
    for (const entry of selected) {
      let block = blocks.at(-1);
      if (block?.kind !== entry.kind) {
        block = { kind: entry.kind, lines: [], omitted: 0 };
        blocks.push(block);
      }
      block.lines.push(entry.line);
    }
    for (const [kind, count] of omitted) {
      const block = blocks.find(item => item.kind === kind);
      if (block) block.omitted = count;
    }
    return blocks;
  }
}
