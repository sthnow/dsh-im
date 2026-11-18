// HFC-only display measurements. Stream times are observed epoch milliseconds,
// not provider-native token/decode timestamps. Never use arrival/commit clocks.
const integer = value => Number.isSafeInteger(value) && value >= 0;
// Fixed broad supported epoch-ms range (2000 through 2100), not a local
// current-time comparison: rejects seconds/microseconds/nanoseconds on replay.
const clock = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 946684800000 && value < 4102444800000;
const text = value => typeof value === 'string' && value.trim().length > 0;
export const completedTurn = reason => (reason?.kind ?? reason) === 'completed';

export function observedStreamWindow(stream) {
  if (!Array.isArray(stream) || stream.length < 2) return null;
  let first, last, finish, samples = 0, nextIndex = 0, generated = false;
  const blocks = new Map();
  const sample = time => {
    if (!clock(time) || (last !== undefined && time < last) || finish !== undefined) return false;
    first ??= time; last = time; samples++; return true;
  };
  const delta = chunk => {
    const type = { 'text-delta': 'text', 'reasoning-delta': 'reasoning', 'tool-call-delta': 'tool-call' }[chunk.type];
    const block = blocks.get(chunk.index);
    if (!type || !integer(chunk.index) || !block || block.closed || block.type !== type) return false;
    if (type === 'tool-call') {
      if (!text(chunk.id) || typeof chunk.argumentsDelta !== 'string' || (block.id && block.id !== chunk.id)
        || (chunk.name !== undefined && !text(chunk.name))) return false;
      block.id = chunk.id;
      if (chunk.argumentsDelta.length) generated = true;
    } else {
      if (typeof chunk.text !== 'string') return false;
      if (chunk.text.length) generated = true;
    }
    return true;
  };
  for (const record of stream) {
    if (!record || typeof record !== 'object') return null;
    if (record.type === 'chunk') {
      const chunk = record.chunk;
      if (!chunk || !sample(record.time)) return null;
      if (chunk.type === 'block-start') {
        if (!integer(chunk.index) || chunk.index !== nextIndex++ || blocks.has(chunk.index)
          || !['text', 'reasoning', 'tool-call', 'tool-addition', 'tool-removal', 'image', 'file'].includes(chunk.blockType)) return null;
        blocks.set(chunk.index, { type: chunk.blockType, closed: false });
      } else if (chunk.type === 'block-end') {
        const block = blocks.get(chunk.index);
        if (!integer(chunk.index) || !block || block.closed || chunk.block?.type !== block.type
          || (block.id && chunk.block.id !== block.id)) return null;
        block.closed = true;
      } else if (chunk.type === 'usage') {
        if (!chunk.usage || typeof chunk.usage !== 'object') return null;
      } else if (chunk.type === 'finish') {
        if (!['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind)
          || [...blocks.values()].some(block => !block.closed)) return null;
        finish = record.time;
      } else if (!delta(chunk)) return null;
    } else if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) {
      const tool = record.type === 'tool-call-chunks';
      const members = tool ? record.args : record.texts;
      if (!integer(record.index) || !Array.isArray(members) || !members.length
        || !members.every(member => typeof member === 'string') || !Array.isArray(record.dt)
        || record.dt.length !== members.length - 1
        || !record.dt.every(dt => typeof dt === 'number' && Number.isFinite(dt) && dt >= 0)) return null;
      let time = record.time0;
      for (let i = 0; i < members.length; i++) {
        if (i) time += record.dt[i - 1];
        const chunk = tool ? { type: 'tool-call-delta', index: record.index, id: record.id, name: record.name, argumentsDelta: members[i] }
          : { type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text: members[i] };
        if (!sample(time) || !delta(chunk)) return null;
      }
    } else return null;
  }
  const seconds = (finish - first) / 1000;
  return finish !== undefined && generated && blocks.size > 0 && samples >= 2 && Number.isFinite(seconds) && seconds > 0 && seconds < 3600
    ? { start: first, end: finish, seconds } : null;
}

export function observedRate(messages, observedSteps, { invalid = false, reason } = {}) {
  if (invalid || (reason !== undefined && !completedTurn(reason)) || !messages.length || !observedSteps.size) return null;
  if ([...observedSteps].some(step => messages.filter(message => message.step === step).length !== 1)) return null;
  const source = messages[0].message?.source;
  if (source?.kind !== 'model' || !text(source.provider) || !text(source.model)) return null;
  let output = 0, seconds = 0, previousEnd;
  for (const message of [...messages].sort((a, b) => a.step - b.step)) {
    const own = message.message?.source;
    if (!integer(message.step) || own?.kind !== 'model' || own.provider !== source.provider || own.model !== source.model
      || message.interrupted || !integer(message.usage?.outputTokens)) return null;
    const window = message.window;
    if (!window || (previousEnd !== undefined && window.start < previousEnd)) return null;
    previousEnd = window.end; output += message.usage.outputTokens; seconds += window.seconds;
  }
  const rate = output / seconds;
  return Number.isSafeInteger(output) && output >= 20 && seconds >= 0.3 && rate > 0 && rate < 1e6
    ? { output_tps: rate, basis: 'decode' } : null;
}

export function terminalContext(snapshot, history, messages, turn, endSeq, reason) {
  if (!snapshot || !completedTurn(reason) || !Array.isArray(history) || !history.length) return null;
  const events = history.map(entry => entry?.event ?? entry).filter(Boolean);
  const latest = events.reduce((a, b) => (b.seq > a.seq ? b : a));
  const lastTurn = events.filter(event => ['turn/start', 'user/message', 'turn/end'].includes(event.type)).at(-1);
  if (!integer(snapshot.asOfSeq) || latest.seq !== snapshot.asOfSeq || !integer(endSeq)
    || snapshot.asOfSeq !== endSeq || snapshot.turn !== turn || lastTurn?.type !== 'turn/end'
    || lastTurn.data?.turn !== turn || lastTurn.seq !== endSeq || !completedTurn(lastTurn.data?.reason)
    || !integer(snapshot.step) || !integer(snapshot.messageSeq) || snapshot.messageSeq >= endSeq
    || !integer(snapshot.contextTokens) || !Number.isSafeInteger(snapshot.contextWindow) || snapshot.contextWindow <= 0
    || !text(snapshot.provider) || !text(snapshot.model)) return null;
  const message = messages.get(snapshot.messageSeq);
  const latestMessage = [...messages.keys()].length ? Math.max(...messages.keys()) : -1;
  if (!message || latestMessage !== snapshot.messageSeq || message.step !== snapshot.step
    || message.message?.source?.kind !== 'model' || message.message.source.provider !== snapshot.provider
    || message.message.source.model !== snapshot.model || message.interrupted) return null;
  return { used_tokens: snapshot.contextTokens, max_tokens: snapshot.contextWindow };
}
