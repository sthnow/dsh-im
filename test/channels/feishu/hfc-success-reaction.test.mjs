import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { DshHfcAdapter } from '../../../src/channels/feishu/hfc/adapter.mjs';
import { VerifiedFeishuChannel } from '../../../src/channels/feishu/feishu-channel.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('expected detached reaction to settle');
}
const incoming = (id, text = 'answer', user = 'user') => ({
  sender: { sender_type: 'user', sender_id: { open_id: user } },
  message: { message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: `chat-${user}`, content: JSON.stringify({ text }) },
});

// Exercise the real bridge, adapter and VerifiedFeishuChannel. Only provider SDK
// and the HFC worker's transport are fakes; reactions use production SDK shapes.
function fixture({ ask, presentation, reactionGate, deleteGate, patchFails = false, sendFails = false, workerFails = false } = {}) {
  const reactions = [], removed = [], writes = [], workerEvents = [], asks = [];
  const sessions = new Map([['p2p:user', 'session-test'], ['p2p:other', 'session-test']]);
  const seen = new Set();
  let seq = 0;
  const send = async request => {
    if (sendFails) throw Error('unknown delivery');
    writes.push(request);
    return { code: 0, data: { message_id: `out-${++seq}` } };
  };
  const client = { im: { v1: {
    message: { create: send, reply: send, patch: async request => {
      if (patchFails) throw Error('unknown patch');
      writes.push(request); return { code: 0 };
    }, delete: async () => ({ code: 0 }) },
    messageReaction: {
      create: async request => {
        const messageId = request.path.message_id, emoji = request.data.reaction_type.emoji_type;
        const reactionId = `reaction-${messageId}-${emoji}`;
        reactions.push({ messageId, emoji, reactionId });
        await reactionGate?.(messageId, emoji);
        return { code: 0, data: { reaction_id: reactionId } };
      },
      delete: async request => {
        await deleteGate?.(request.path.message_id);
        removed.push({ messageId: request.path.message_id, reactionId: request.path.reaction_id });
        return { code: 0 };
      },
    },
  } }, cardkit: { v1: {
    card: { create: async () => ({ code: 0, data: { card_id: `card-${++seq}` } }), settings: async () => ({ code: 0 }) },
    cardElement: { content: async () => ({ code: 0 }) },
  } } };
  const status = { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 };
  const bridge = new FeishuHarnessBridge({
    client, channel: new VerifiedFeishuChannel({ client }),
    harness: { sessionExists: async () => true, ask: async (id, text, options) => {
      asks.push({ id, text });
      return ask ? ask(id, text, options) : complete(options);
    } },
    state: { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: key => sessions.get(key),
      setSession: async (key, id) => sessions.set(key, id), clearSession: async key => sessions.delete(key) },
    status, allowedSenderOpenIds: new Set(['user', 'other']), botId: 'bot-test',
    hfcRuntimeNamespace: '11111111-1111-4111-8111-111111111111',
    stepPush: true, stepPushMode: 'hermes_card',
    hfcPresentation: presentation ?? { backend: 'hfc', testSessionIds: ['session-test'] },
    hfcAdapterFactory: config => new DshHfcAdapter({ ...config, worker: {
      async start() { if (workerFails) throw Object.assign(Error('worker closed'), { code: 'worker-exited' }); },
      async close() {}, async reset() {},
      async event(event) { workerEvents.push(event); return { accepted: true, disposition: 'card',
        card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: event.data.answer ?? event.event }] } } }; },
    } }),
    logger: { warn() {}, error() {}, info() {} },
  });
  const run = async (id = 'in', text, user) => { await bridge.accept(incoming(id, text, user)); await bridge.waitForIdle(); };
  return { bridge, run, reactions, removed, writes, asks, sessions, workerEvents, status };
}
async function complete(options, reason = 'completed') {
  await options.onUpdate({ type: 'turn-start', turn: 73 });
  await options.onUpdate({ type: 'text', turn: 73, step: 0, text: 'partial' });
  await options.onUpdate({ type: 'turn-end', turn: 73, reason: { kind: reason } });
  return 'canonical answer';
}
const emojis = (f, id) => f.reactions.filter(r => r.messageId === id).map(r => r.emoji);
const assertRemoved = (f, id) => assert.ok(f.removed.some(r => r.messageId === id && r.reactionId === `reaction-${id}-OnIt`));

test('actual successful HFC display removes only its OnIt and never adds DONE', async () => {
  const f = fixture(); await f.run();
  await until(() => f.removed.length === 1);
  assert.deepEqual(emojis(f, 'in'), ['OnIt']); assertRemoved(f, 'in');
  assert.equal(f.workerEvents.at(-1).event, 'message.completed');
  assert.equal(f.asks.length, 1);
});

for (const reason of ['error', 'aborted', 'interrupted', 'stopped', 'cancelled', 'canceled']) {
  test(`HFC normally returned non-success turn-end ${reason} keeps ERROR, not DONE`, async () => {
    const f = fixture({ ask: (_id, _text, options) => complete(options, reason) });
    await f.run(); await until(() => emojis(f, 'in').includes('ERROR'));
    assert.deepEqual(emojis(f, 'in'), ['OnIt', 'ERROR']); assertRemoved(f, 'in');
    assert.equal(f.workerEvents.at(-1).event, 'message.failed');
  });
}

for (const fault of ['ask', 'patch', 'send']) {
  test(`HFC ${fault} failure follows ERROR path without success cleanup`, async () => {
    const f = fixture({ patchFails: fault === 'patch', sendFails: fault === 'send',
      ask: async (_id, _text, options) => {
        if (fault === 'ask') { await options.onUpdate({ type: 'turn-start', turn: 73 }); throw Error('ask failed'); }
        return complete(options);
      } });
    await f.run(); await until(() => emojis(f, 'in').includes('ERROR'));
    assert.deepEqual(emojis(f, 'in'), ['OnIt', 'ERROR']); assertRemoved(f, 'in');
  });
}

test('confirmed same-owner native fallback is still a successful HFC turn', async () => {
  const f = fixture({ workerFails: true }); await f.run();
  await until(() => f.removed.length === 1);
  assert.deepEqual(emojis(f, 'in'), ['OnIt']); assertRemoved(f, 'in');
  assert.equal(f.asks.length, 1);
});

for (const presentation of [
  { backend: 'legacy', testSessionIds: ['session-test'] },
  { backend: 'hfc', testSessionIds: ['not-selected'] },
]) {
  test(`non-HFC execution retains DONE: ${JSON.stringify(presentation)}`, async () => {
    const f = fixture({ presentation }); await f.run();
    await until(() => emojis(f, 'in').includes('DONE'));
    assert.deepEqual(emojis(f, 'in'), ['OnIt', 'DONE']); assertRemoved(f, 'in');
    assert.equal(f.workerEvents.length, 0);
  });
}

test('normal command in HFC-selected session retains DONE and does not ask', async () => {
  const f = fixture(); await f.run('command', '/help');
  await until(() => emojis(f, 'command').includes('DONE'));
  assert.deepEqual(emojis(f, 'command'), ['OnIt', 'DONE']); assertRemoved(f, 'command');
  assert.equal(f.asks.length, 0); assert.equal(f.workerEvents.length, 0);
});

test('delayed SDK OnIt cannot block next turn or acquire its different reaction outcome after rebinding', async () => {
  const firstAdd = deferred();
  const f = fixture({ reactionGate: (id, emoji) => id === 'first' && emoji === 'OnIt' ? firstAdd.promise : undefined });
  // Both promises settle while the first SDK reaction is explicitly still gated.
  await f.run('first');
  assert.equal(f.removed.length, 0); assert.deepEqual(emojis(f, 'first'), ['OnIt']);
  f.sessions.set('p2p:user', 'session-legacy');
  await f.run('second');
  await until(() => emojis(f, 'second').includes('DONE'));
  assert.deepEqual(emojis(f, 'second'), ['OnIt', 'DONE']); assertRemoved(f, 'second');
  firstAdd.resolve();
  await until(() => f.removed.some(r => r.messageId === 'first'));
  assert.deepEqual(emojis(f, 'first'), ['OnIt']); assertRemoved(f, 'first');
  assert.equal(f.asks.length, 2);
  assert.equal(f.reactions.some(r => r.messageId === 'first' && r.emoji === 'DONE'), false);
});

test('delayed HFC cleanup does not clear a concurrent command or another conversation failure', async () => {
  const removeFirst = deferred();
  const f = fixture({ deleteGate: id => id === 'first' ? removeFirst.promise : undefined,
    ask: (_id, text, options) => complete(options, text === 'fail' ? 'error' : 'completed') });
  await f.run('first');
  await Promise.all([f.run('command', '/help'), f.run('other', 'fail', 'other')]);
  await until(() => emojis(f, 'command').includes('DONE') && emojis(f, 'other').includes('ERROR'));
  assert.deepEqual(emojis(f, 'command'), ['OnIt', 'DONE']);
  assert.deepEqual(emojis(f, 'other'), ['OnIt', 'ERROR']);
  assert.equal(f.removed.some(r => r.messageId === 'first'), false);
  removeFirst.resolve(); await until(() => f.removed.length === 3);
  assert.deepEqual(emojis(f, 'first'), ['OnIt']);
  for (const id of ['first', 'command', 'other']) assertRemoved(f, id);
});
