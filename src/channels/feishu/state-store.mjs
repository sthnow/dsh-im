import { deferredStateAccess, normalizeDeferredState } from '../shared/deferred-state.mjs';
import { acquireCore, assertCoreReadable, assertCoreUsable, beginCoreRetirement, loadCore, releaseCore, retireCore, stateError, writeStateSnapshot } from './state-coordination.mjs';

const EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  watches: {},
  deferred: {},
  includeArchivedSessions: false,
  topics: {},
  mirrors: {},
});

/** One conversation key may watch at most this many sessions. */
export const MAX_WATCHES_PER_KEY = 20;

/** A persisted watch entry: the watched session plus its delivery target. */
function validWatchEntry(value) {
  return value
    && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.chatId === 'string' && value.chatId.length > 0;
}

export class StateStore {
  #core;
  #closed = false;
  #closePromise;
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path) { this.#core = acquireCore(path, EMPTY_STATE); }

  get #state() {
    this.#assertOpen();
    assertCoreReadable(this.#core);
    return this.#core.state;
  }

  #assertOpen() {
    if (this.#closed) throw stateError('FEISHU_STATE_CLOSED', 'Feishu state handle is closed');
  }

  #authorize() {
    this.#assertOpen();
    assertCoreUsable(this.#core);
  }

  async load() {
    this.#assertOpen();
    if (!this.#core.loading) {
      this.#core.loading = Promise.resolve().then(() => loadCore(this.#core, (parsed) => ({
        version: 1,
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.slice(-1000) : [],
        watches: parsed.watches && typeof parsed.watches === 'object' ? parsed.watches : {},
        deferred: normalizeDeferredState(parsed.deferred),
        includeArchivedSessions: parsed.includeArchivedSessions === true,
        topics: parsed.topics && typeof parsed.topics === 'object' ? parsed.topics : {},
        mirrors: parsed.mirrors && typeof parsed.mirrors === 'object' ? parsed.mirrors : {},
      }))).finally(() => { this.#core.loading = null; });
    }
    await this.#core.loading;
    this.#assertOpen();
    assertCoreUsable(this.#core);
    return this;
  }

  beginRetirement() { this.#assertOpen(); return beginCoreRetirement(this.#core); }
  retire() { this.#assertOpen(); return retireCore(this.#core); }
  static async retirePath(path) {
    const core = acquireCore(path, EMPTY_STATE);
    try { await retireCore(core); } finally { await releaseCore(core); }
  }
  close() {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = releaseCore(this.#core);
    }
    return this.#closePromise;
  }

  deferredEntries() { return this.#deferred.entries(); }
  async putDeferred(entry) { this.#authorize(); return this.#deferred.put(entry); }
  async patchDeferred(id, patch) { this.#authorize(); return this.#deferred.patch(id, patch); }
  async removeDeferred(id) { this.#authorize(); return this.#deferred.remove(id); }

  // ── Mirrors (persisted: open session-sync cards, recovered at startup) ──
  setMirror(sessionId, entry) {
    this.#authorize();
    this.#state.mirrors[sessionId] = entry;
    return this.#persist();
  }

  clearMirror(sessionId) {
    this.#authorize();
    delete this.#state.mirrors[sessionId];
    return this.#persist();
  }

  mirrorEntries() {
    return Object.entries(this.#state.mirrors ?? {});
  }

  /** Queue a fresh snapshot, including mutations whose earlier write failed. */
  flush() {
    this.#authorize();
    return this.#persist();
  }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  async setSession(key, sessionId) {
    this.#authorize();
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }

  async clearSession(key) {
    this.#authorize();
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    this.#authorize();
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    this.#authorize();
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1000);
    }
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  // ── Watches (persisted: surviving restarts) ─────────────────────────────

  watchEntries(key) {
    const list = this.#state.watches[key];
    return Array.isArray(list) ? list.filter(validWatchEntry) : [];
  }

  watchEntry(key, sessionId) {
    return this.watchEntries(key).find((entry) => entry.sessionId === sessionId) ?? null;
  }

  async setWatch(key, entry) {
    this.#authorize();
    const list = this.#state.watches[key] ?? [];
    const index = list.findIndex((existing) => existing.sessionId === entry.sessionId);
    if (index === -1) {
      if (list.length >= MAX_WATCHES_PER_KEY) list.shift();
      list.push(entry);
    } else {
      list[index] = entry;
    }
    this.#state.watches[key] = list;
    await this.#persist();
  }

  async removeWatch(key, sessionId) {
    this.#authorize();
    const list = this.#state.watches[key] ?? [];
    this.#state.watches[key] = list.filter((entry) => entry.sessionId !== sessionId);
    await this.#persist();
  }

  async clearWatches(key) {
    this.#authorize();
    delete this.#state.watches[key];
    await this.#persist();
  }

  /** Every conversation key currently watching the given session. */
  keysWatching(sessionId) {
    return Object.entries(this.#state.watches)
      .filter(([, list]) => Array.isArray(list) && list.some((entry) => validWatchEntry(entry) && entry.sessionId === sessionId))
      .map(([key]) => key);
  }

  /** Unique watched session ids across all keys (restart compensation). */
  watchedSessionIds() {
    const ids = new Set();
    for (const list of Object.values(this.#state.watches)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (validWatchEntry(entry)) ids.add(entry.sessionId);
    }
    return [...ids];
  }

  // ── Deferred delivery (persisted: surviving restarts) ───────────────────

  // ── Managed Feishu topics (thread_id → root message, persisted) ────────

  topicRootFor(threadId) {
    const entry = this.#state.topics[threadId];
    return entry && typeof entry === 'object'
      && typeof entry.rootMessageId === 'string' && entry.rootMessageId.length > 0
      && typeof entry.chatId === 'string' && entry.chatId.length > 0
      ? { rootMessageId: entry.rootMessageId, chatId: entry.chatId }
      : null;
  }

  async setTopic(threadId, root) {
    this.#authorize();
    const validRoot = root && typeof root === 'object'
      && typeof root.rootMessageId === 'string' && root.rootMessageId.length > 0
      && typeof root.chatId === 'string' && root.chatId.length > 0;
    if (!validRoot) throw new TypeError('Invalid Feishu topic root');
    this.#state.topics[threadId] = {
      rootMessageId: root.rootMessageId,
      chatId: root.chatId,
    };
    await this.#persist();
  }

  // ── Session-list archived policy (per bot) ───────────────────

  includesArchivedSessions() {
    return this.#state.includeArchivedSessions === true;
  }

  async setIncludeArchivedSessions(include) {
    this.#authorize();
    this.#state.includeArchivedSessions = include === true;
    await this.#persist();
  }

  #persist() {
    // Snapshot capture and mirror replacement both happen before the first await.
    // Retirement drains these already-authorized snapshots, then commits its fence.
    const core = this.#core;
    const snapshot = JSON.stringify(core.state, null, 2) + '\n';
    const operation = core.queue.then(() => writeStateSnapshot(core, snapshot));
    core.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
