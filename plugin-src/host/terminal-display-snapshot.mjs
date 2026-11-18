const index = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const route = value => typeof value?.provider === 'string' && value.provider.length > 0
  && typeof value?.model === 'string' && value.model.length > 0;
const sameRoute = (left, right) => route(left) && route(right)
  && left.provider === right.provider && left.model === right.model;

function validUsage(usage) {
  return usage && positive(usage.inputTokens) && nonnegative(usage.outputTokens)
    && ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
      .every(key => usage[key] === undefined || nonnegative(usage[key]));
}

/** Synchronous domain getter: returns detached primitives only, never retains Session.
 * asOfSeq is the inclusive RPC history cursor, NOT Session.seq (the next offset).
 * Fail closed rather than applying current pressure to an older terminal message.
 */
export function terminalDisplaySnapshot(session, tokenMeter, { sessionId, asOfSeq, entries }) {
  if (!session || session.id !== sessionId || !index(asOfSeq)
    || session.seq !== asOfSeq + 1 || typeof session.eventAt !== 'function'
    || typeof tokenMeter?.contextPressure !== 'function') return undefined;

  // Walk only the latest turn. A later batch member is already committed even
  // when its session/event notification has not yet advanced the RPC cursor.
  let ended, stepEnd, message, stepStart, started;
  for (let seq = asOfSeq; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (!event || event.seq !== seq) return undefined;
    if (!ended) {
      if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return undefined;
      ended = event;
    } else if (!stepEnd) {
      if (event.type !== 'step/end') return undefined;
      stepEnd = event;
    } else if (!message) {
      if (event.type !== 'assistant/message') return undefined;
      message = event;
    } else if (event.type === 'step/start') {
      stepStart = event;
      // Earlier steps may exist, but this must be the latest step start.
      for (let prior = seq - 1; prior >= 0; prior--) {
        const item = session.eventAt(prior);
        if (!item || item.seq !== prior) return undefined;
        if (item.type === 'turn/end') return undefined;
        if (item.type === 'turn/start') { started = item; break; }
      }
      break;
    } else if (['request/header', 'request/context', 'assistant/message', 'assistant/attempt',
      'turn/start', 'turn/end', 'step/end'].includes(event.type)) {
      // Header/context before the message belong to this call; between the
      // message and latest step/start only request metadata and inputs are valid.
      if (!['request/header', 'request/context'].includes(event.type)) return undefined;
    }
  }
  if (!started || !stepStart || !index(ended.data?.turn) || !index(stepStart.data?.step)) return undefined;
  const turn = ended.data.turn, step = stepStart.data.step;
  if ([started, stepStart, stepEnd, message].some(event => event.data?.turn !== turn)
    || [stepEnd, message].some(event => event.data?.step !== step)) return undefined;

  const data = message.data, source = data?.message?.source;
  if (data?.message?.role !== 'assistant' || source?.kind !== 'model'
    || data.interrupted === true || !validUsage(data.usage)) return undefined;
  if (data.stream?.some(record => record?.type === 'chunk'
    && record.chunk?.type === 'finish'
    && ['error', 'aborted'].includes(record.chunk.reason?.kind))) return undefined;
  const header = session.requestHeader?.()?.config;
  const context = session.requestContext?.();
  if (!sameRoute(source, header) || !sameRoute(source, context) || !positive(context.contextWindow)) return undefined;

  // History must actually contain this durable assistant from this exact cut.
  // No payload mutation: the snapshot is a sibling, never message metadata.
  if (!Array.isArray(entries) || !entries.some(entry => {
    const event = entry?.event;
    return event?.type === 'assistant/message' && event.seq === message.seq
      && event.data?.turn === turn && event.data?.step === step
      && event.data?.message?.role === 'assistant'
      && sameRoute(event.data.message.source, source);
  })) return undefined;
  const pressure = tokenMeter.contextPressure(session);
  if (!positive(pressure?.pressureTokens) || !positive(pressure?.contextWindow)
    || pressure.contextWindow !== context.contextWindow || session.seq !== asOfSeq + 1) return undefined;
  return Object.freeze({ asOfSeq, turn, step, messageSeq: message.seq,
    provider: source.provider, model: source.model,
    contextTokens: pressure.pressureTokens, contextWindow: pressure.contextWindow });
}
