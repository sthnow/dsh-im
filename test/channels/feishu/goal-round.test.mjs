import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { directAccessPolicy } from '../access-policy-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

const TOPIC = 'group:chat-1:thread:thread-1';
const DM = 'p2p:ou_owner';
const SESSION = 'session';
const OTHER_SESSION = 'session-2';

// A real goal round's user/message carries no `data.turn`; only the
// turn/start right before it does.
const goal = (round = 1, seq = 100) => ({
  type: 'user/message',
  seq,
  surfaceOp: 'append',
  data: {
    source: { kind: 'goal', goalId: 'goal-1', revision: 1, round },
    content: [{
      type: 'text',
      text: `<goal_round>\nObjective: "keep building the service"\nRound: ${round}/256\n\nContinue working toward the objective.`,
    }],
  },
});
const start = (turn = 4, seq = 99) => ({ type: 'turn/start', seq, data: { turn } });
const tool = (turn = 4, seq = 102) => ({
  type: 'tool/call', seq, data: { turn, name: 'bash', arguments: '{"command":"ls"}' },
});
const answer = (text, turn = 4, seq = 103) => ({
  type: 'assistant/message',
  seq,
  surfaceOp: 'append',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
});
const end = (turn = 4, seq = 104, kind = 'completed') => ({
  type: 'turn/end', seq, data: { turn, reason: { kind } },
});

async function fixture(t, {
  resolver = async () => [],
  accessPolicy,
  keys = [[TOPIC, 'chat-1', 'om-topic-1']],
  stepPushMode,
  rejectReply = () => false,
  rejectCreate = () => false,
  rejectPatch = () => false,
  beforePatch = async () => {},
  beforeReply = null,
  delay = async () => {},
} = {}) {
  let listener;
  const controller = new AbortController();
  const creates = [];
  const replies = [];
  const patches = [];
  const visible = new Map();
  const bindings = new Map(keys.map(([key, , , sessionId]) => [key, sessionId ?? SESSION]));
  const state = {
    sessionFor: key => bindings.get(key),
    hasSeen: () => false,
    markSeen: async () => {},
    keysWatching: () => [],
    watchEntry: () => undefined,
    setMirror: async () => {},
    clearMirror: async () => {},
    mirrorEntries: () => [],
  };
  const harness = {
    watchHarnessEvents: ({ onSessionEvent, signal }) => {
      listener = onSessionEvent;
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    rpc: async () => ({ events: [], hasMore: false }),
    ensureRunning: async () => true,
    sessionExists: async () => true,
  };
  const bridge = new FeishuHarnessBridge({
    botId: 'bot-a',
    harness,
    state,
    status: {},
    channel: {},
    signal: controller.signal,
    allowedSenderOpenIds: new Set(['ou_owner']),
    accessPolicy,
    logger: { warn() {}, debug() {}, error() {} },
    sessionSyncTargetsFor: resolver,
    stepPushMode,
    stepPushClock: { now: () => Date.now(), delay },
    client: {
      im: {
        v1: {
          message: {
            create: async request => {
              creates.push(structuredClone(request));
              if (rejectCreate(request, creates.length)) return { code: 230001, msg: 'injected create failure' };
              const id = `card-${creates.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
            patch: async request => {
              patches.push(structuredClone(request));
              await beforePatch(request, patches.length);
              if (rejectPatch(request, patches.length)) return { code: 230001, msg: 'injected patch failure' };
              visible.set(request.path.message_id, request.data.content);
              return { code: 0 };
            },
            reply: async request => {
              replies.push(structuredClone(request));
              if (beforeReply) await beforeReply(request, replies.length);
              if (rejectReply(request, replies.length)) return { code: 230001, msg: 'injected reply failure' };
              const id = `reply-${replies.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
          },
        },
      },
    },
  });
  t.after(() => controller.abort());
  await flush();
  for (const [key, chatId, replyToMessageId] of keys) {
    bridge.rememberConversationRoute(key, { chatId, replyToMessageId });
  }
  // Simulate the modern Host's authoritative attribution for the existing
  // delivery scenarios. Tests can bypass this with emitRaw.
  const starts = new Map();
  const emitRaw = (event, sessionId = SESSION) => listener({ sessionId, event });
  const emit = (event, sessionId = SESSION) => {
    let events = starts.get(sessionId);
    if (!events) starts.set(sessionId, events = new Map());
    if (event.type === 'turn/start') {
      const prior = events.get(event.seq);
      events.set(event.seq, prior === undefined || prior === event.data.turn ? event.data.turn : null);
      if (events.size > 256) events.delete(Math.min(...events.keys()));
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'goal' && event.data.turn === undefined) {
      const boundaries = [...events.keys()].filter(seq => seq < event.seq).sort((a, b) => b - a);
      const turn = events.get(boundaries[0]);
      if (Number.isSafeInteger(turn)) event = { ...event, data: { ...event.data, turn } };
    }
    emitRaw(event, sessionId);
  };
  const drain = async () => {
    await bridge.waitForIdle();
    await flush();
  };
  const cardFor = id => visible.get(id) ?? '';
  return {
    bridge, emit, emitRaw, drain, creates, replies, patches, visible, cardFor,
    bind: (key, sessionId) => bindings.set(key, sessionId),
  };
}

test('Hermes ignores a complete replay of an already finished goal round', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  const replay = [start(), goal(), answer('唯一结果'), end()];
  for (const event of replay) f.emit(event);
  await f.drain();
  for (const event of replay) f.emit(event);
  await f.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.creates.length, 0);
  assert.match(f.cardFor('reply-1'), /唯一结果/);
});

test('Hermes replay window retains the last 256 delivered turns', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  for (let turn = 1; turn <= 257; turn++) {
    const seq = turn * 10;
    f.emit(start(turn, seq)); f.emit(goal(turn, seq + 1)); f.emit(end(turn, seq + 2));
  }
  await f.drain();
  assert.equal(f.replies.length, 257);
  f.emit(start(257, 2570)); f.emit(goal(257, 2571)); f.emit(end(257, 2572));
  await f.drain();
  assert.equal(f.replies.length, 257);
  const explicitOldGoal = goal(1, 11);
  explicitOldGoal.data.turn = 1;
  f.emit(start(1, 10)); f.emit(explicitOldGoal); f.emit(end(1, 12));
  await f.drain();
  assert.equal(f.replies.length, 258, 'explicit evicted turns are outside the replay guarantee');
});

for (const evicted of [false, true]) {
  test(`Hermes old round replay cannot displace a newer active round (${evicted ? 'evicted' : 'seen'})`, async t => {
    const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-topic-1']] });
    const last = evicted ? 258 : 2;
    for (let turn = 1; turn < last; turn++) {
      const seq = turn * 10;
      f.emit(start(turn, seq)); f.emit(goal(turn, seq + 1)); f.emit(end(turn, seq + 2));
    }
    await f.drain();
    f.emit(start(last, last * 10)); f.emit(goal(last, last * 10 + 1)); await f.drain();
    const count = f.replies.length;
    f.emit(start(1, 10)); f.emit(goal(1, 11)); f.emit(answer('旧轮答案', 1, 12)); f.emit(end(1, 13));
    await f.drain();
    assert.equal(f.replies.length, count + (evicted ? 1 : 0), 'unproven replay may only send a notice');
    if (evicted) assert.match(f.cardFor(`reply-${count + 1}`), /归属无法确认/);
    f.emit(answer('新轮最终答案', last, last * 10 + 2));
    f.emit(end(last, last * 10 + 3)); await f.drain();
    assert.match(f.cardFor(`reply-${count}`), /新轮最终答案/);
    assert.doesNotMatch(f.cardFor(`reply-${count}`), /旧轮答案/);
  });
}

test('goal starts are associated by sequence across interleaved old replays', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  f.emit(start(1, 10)); f.emit(goal(1, 11)); f.emit(end(1, 12));
  f.emit(start(2, 20));
  // The older goal arrives after the new start, then the old start is replayed
  // before the new goal. Neither may change the other goal's ownership.
  f.emit(goal(1, 11)); f.emit(start(1, 10)); f.emit(goal(2, 21));
  f.emit(answer('第二轮结果', 2, 22)); f.emit(end(2, 23));
  await f.drain();
  assert.equal(f.replies.length, 2);
  assert.match(f.cardFor('reply-2'), /第二轮结果/);
});

test('missing later start must not assign new goal to older turn', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-topic-1']] });
  f.emit(start(1, 10)); f.emit(goal(1, 11)); f.emit(end(1, 12));
  // start(2, 20) was missed by the watch stream.
  f.emitRaw(goal(2, 21)); f.emit(answer('第二轮结果', 2, 22)); f.emit(end(2, 23));
  await f.drain();
  assert.equal(f.replies.length, 2, 'without proof the bridge sends only a notice');
  assert.match(f.cardFor('reply-2'), /归属无法确认/);
  assert.doesNotMatch(f.cardFor('reply-2'), /第二轮结果|Objective/);
  const proven = goal(2, 21); proven.data.turn = 2;
  f.emitRaw(proven); f.emit(answer('第二轮结果', 2, 22)); f.emit(end(2, 23));
  await f.drain();
  assert.equal(f.replies.length, 3);
  assert.match(f.cardFor('reply-3'), /第二轮结果/);
});

test('unknown goal notices isolate targets and retry only failures', async t => {
  const second = 'group:chat-2';
  let failed = false;
  const f = await fixture(t, {
    stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-1'], [second, 'chat-2', 'om-2']],
    rejectReply: request => {
      if (request.path.message_id === 'om-2' && !failed) { failed = true; return true; }
      return false;
    },
  });
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 2);
  assert.equal(f.creates.length, 0, 'failure must not expose locator to main chat');
  assert.match(f.cardFor('reply-1'), /session: session.*seq: 100/);
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 3);
  assert.equal(f.replies[2].path.message_id, 'om-2');
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 3);
});

test('unknown goal notice checks binding after earlier target waits', async t => {
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const second = 'group:chat-2';
  const f = await fixture(t, {
    stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-1'], [second, 'chat-2', 'om-2']],
    beforeReply: async (_request, count) => { if (count === 1) { entered(); await blocked; } },
  });
  f.emitRaw(goal()); await started;
  f.bind(second, OTHER_SESSION);
  release(); await f.drain();
  assert.equal(f.replies.length, 1);
  f.bind(second, SESSION);
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 2);
});

test('unknown goal never posts an unverified topic route to a group', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [[TOPIC, 'chat-1', 'om-topic']] });
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 0);
  assert.equal(f.creates.length, 0);
});

test('denied inbound message cannot replace a bound goal route', async t => {
  const f = await fixture(t, {
    stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-safe']],
    accessPolicy: directAccessPolicy({ privilegedIds: ['ou_owner'] }),
  });
  await f.bridge.accept({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_denied' } },
    message: { message_id: 'om-denied', chat_type: 'group', chat_id: 'chat-1', message_type: 'text', content: JSON.stringify({ text: 'secret' }) },
  });
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].path.message_id, 'om-safe');
  assert.match(f.cardFor('reply-1'), /本路径暂无法确认最终答案的投递情况/);
  assert.doesNotMatch(f.cardFor('reply-1'), /未投递最终答案|secret/);
});

const topicInbound = (id, sender, text = '/help') => ({
  sender: { sender_type: 'user', sender_id: { open_id: sender } },
  message: { message_id: id, chat_type: 'group', chat_id: 'chat-1', thread_id: 'thread-1', message_type: 'text', content: JSON.stringify({ text }) },
});

test('denied topic command receipt stays threaded and cannot replace the goal route', async t => {
  const policy = directAccessPolicy();
  policy.getSettings().group.allowlist.users.push({ id: 'ou_member', canExecuteCommands: false });
  const f = await fixture(t, { stepPushMode: 'hermes_card', accessPolicy: policy, keys: [[TOPIC, 'chat-1', 'om-safe']] });
  await f.bridge.accept(topicInbound('om-denied-command', 'ou_member'));
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].data.reply_in_thread, true);
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, 1, 'denied command must not authenticate the old route or itself');
  assert.equal(f.creates.length, 0);
});

test('denied topic command cannot overwrite an already authorized goal anchor', async t => {
  const policy = directAccessPolicy({ privilegedIds: ['ou_owner'] });
  policy.getSettings().group.allowlist.users.push({ id: 'ou_member', canExecuteCommands: false });
  const f = await fixture(t, { stepPushMode: 'hermes_card', accessPolicy: policy });
  await f.bridge.accept(topicInbound('om-authorized', 'ou_owner'));
  await f.drain();
  f.emitRaw(goal(2, 99)); await f.drain();
  assert.equal(f.replies.at(-1).path.message_id, 'om-authorized');
  assert.equal(f.replies.at(-1).data.reply_in_thread, true);
  await f.bridge.accept(topicInbound('om-denied-command', 'ou_member'));
  await f.drain();
  assert.equal(f.replies.at(-1).path.message_id, 'om-denied-command');
  assert.equal(f.replies.at(-1).data.reply_in_thread, true);
  const count = f.replies.length;
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, count + 1);
  assert.equal(f.replies.at(-1).path.message_id, 'om-authorized');
  assert.equal(f.replies.at(-1).data.reply_in_thread, true);
});

test('authorized topic notice is threaded and evicted anchor fails closed', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  await f.bridge.accept(topicInbound('om-authorized', 'ou_owner'));
  await f.drain();
  const initial = f.replies.length;
  f.emitRaw(goal()); await f.drain();
  assert.equal(f.replies.length, initial + 1);
  assert.equal(f.replies.at(-1).path.message_id, 'om-authorized');
  assert.equal(f.replies.at(-1).data.reply_in_thread, true);
  for (let i = 0; i < 2049; i++) await f.bridge.accept(topicInbound(`om-evict-${i}`, 'ou_owner'));
  await f.drain();
  f.bridge.rememberConversationRoute(TOPIC, { chatId: 'chat-1', replyToMessageId: 'om-authorized' });
  const count = f.replies.length;
  const creates = f.creates.length;
  f.emitRaw(goal(2, 200)); await f.drain();
  assert.equal(f.replies.length, count);
  assert.equal(f.creates.length, creates);
});

test('goal start history rejects events older than its retained boundary', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-topic-1']] });
  for (let turn = 1; turn <= 257; turn++) f.emit(start(turn, turn * 10));
  f.emit(start(1, 10)); f.emit(goal(1, 11));
  f.emit(goal(257, 2571)); f.emit(answer('新轮结果', 257, 2572)); f.emit(end(257, 2573));
  await f.drain();
  assert.equal(f.replies.length, 2);
  assert.match(f.cardFor('reply-1'), /归属无法确认/);
  assert.match(f.cardFor('reply-2'), /新轮结果/);
});

test('conflicting turn starts at one sequence do not guess goal ownership', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [['group:chat-1', 'chat-1', 'om-topic-1']] });
  f.emit(start(1, 10)); f.emit(start(2, 10)); f.emit(start(1, 10)); f.emit(goal(1, 11));
  await f.drain();
  assert.equal(f.replies.length, 1);
  assert.match(f.cardFor('reply-1'), /归属无法确认/);
  f.emit(start(3, 20)); f.emit(goal(3, 21)); f.emit(answer('第三轮结果', 3, 22)); f.emit(end(3, 23));
  await f.drain();
  assert.equal(f.replies.length, 2);
  assert.match(f.cardFor('reply-2'), /第三轮结果/);
});

test('Hermes retries a failed initial card on replay', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', rejectReply: (_, n) => n === 1,
    rejectCreate: (_, n) => n === 1 });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit(start()); f.emit(goal()); await f.drain();
  assert.equal(f.replies.length, 2);
  assert.match(f.cardFor('reply-2'), /目标自动续跑/);
});

for (const finishBeforeReplay of [false, true]) {
  test(`Hermes retries only the failed destination (${finishBeforeReplay ? 'finished' : 'active'} peer)`, async t => {
    const topic2 = 'group:chat-2:thread:thread-2';
    let fail = true;
    const f = await fixture(t, {
      stepPushMode: 'hermes_card',
      keys: [[TOPIC, 'chat-1', 'om-topic-1'], [topic2, 'chat-2', 'om-topic-2']],
      rejectReply: request => fail && request.path.message_id === 'om-topic-2',
      rejectCreate: () => fail,
    });
    f.emit(start()); f.emit(goal()); await f.drain();
    if (finishBeforeReplay) { f.emit(answer('最终结果')); f.emit(end()); await f.drain(); }
    fail = false;
    f.emit(start()); f.emit(goal()); f.emit(answer('最终结果')); f.emit(end()); await f.drain();
    const cards = () => f.replies.filter(r => r.data.msg_type === 'interactive');
    assert.equal(cards().filter(r => r.path.message_id === 'om-topic-1').length, 1);
    assert.equal(cards().filter(r => r.path.message_id === 'om-topic-2').length, 2);
    assert.match(f.cardFor('reply-1'), /最终结果/);
    assert.match(f.cardFor(`reply-${f.replies.length}`), /最终结果/);
    f.emit(start()); f.emit(goal()); f.emit(answer('最终结果')); f.emit(end()); await f.drain();
    assert.equal(cards().length, 3, 'neither successful destination is reopened');
  });
}

test('Hermes remembers a successful fallback only for its destination', async t => {
  const topic2 = 'group:chat-2:thread:thread-2';
  const f = await fixture(t, {
    stepPushMode: 'hermes_card',
    keys: [[TOPIC, 'chat-1', 'om-topic-1'], [topic2, 'chat-2', 'om-topic-2']],
    rejectReply: request => request.path.message_id === 'om-topic-2' && request.data.msg_type === 'interactive',
    rejectCreate: request => request.data.msg_type === 'interactive',
  });
  const events = [start(), goal(), answer('最终文本'), end()];
  for (const event of events) f.emit(event);
  await f.drain();
  const count = f.replies.length;
  assert.match(f.cardFor(`reply-${count}`), /最终文本/);
  for (const event of events) f.emit(event);
  await f.drain();
  assert.equal(f.replies.length, count, 'successful text fallback must not be delivered twice');
});

test('Hermes does not remember a round with no eligible target', async t => {
  let synced = true;
  const f = await fixture(t, { stepPushMode: 'hermes_card', keys: [[DM, 'chat-1', null]],
    resolver: async () => synced ? [{ botId: 'bot-a', openId: 'ou_owner' }] : [] });
  f.emit(start()); f.emit(goal()); await f.drain();
  assert.equal(f.creates.length, 0);
  synced = false;
  f.emit(start()); f.emit(goal()); await f.drain();
  assert.equal(f.creates.length, 1);
});

test('queued Hermes goal render is discarded after rebinding', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  let first = true;
  const f = await fixture(t, { stepPushMode: 'hermes_card', delay: async () => {
    if (first) { first = false; entered(); await gate; }
  } });
  f.emit(start()); f.emit(goal());
  await waiting;
  f.bind(TOPIC, OTHER_SESSION);
  release(); await f.drain();
  assert.equal(f.replies.length, 0);
});

test('old session events cannot seal or update a rebound session card', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.bind(TOPIC, OTHER_SESSION);
  f.emit(start(), OTHER_SESSION); f.emit(goal(), OTHER_SESSION); await f.drain();
  f.emit(answer('旧轮次污染', 4, 103)); f.emit(end()); await f.drain();
  f.emit(answer('新会话结果', 4, 103), OTHER_SESSION); await f.drain();
  assert.equal(f.replies.length, 2);
  assert.match(f.cardFor('reply-2'), /新会话结果/);
  assert.doesNotMatch(f.cardFor('reply-2'), /旧轮次污染|本轮回复已结束/);
  f.emit(end(), OTHER_SESSION); await f.drain();
  assert.match(f.cardFor('reply-2'), /本轮回复已结束/);
});

test('rebinding while the previous card seals prevents the old round opening a card', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let hold = false;
  const f = await fixture(t, { stepPushMode: 'hermes_card', beforePatch: async () => {
    if (hold) { hold = false; entered(); await gate; }
  } });
  f.emit(start()); f.emit(goal()); await f.drain();
  hold = true;
  f.emit(start(5, 200)); f.emit(goal(2, 201));
  await waiting;
  f.bind(TOPIC, OTHER_SESSION);
  release();
  await f.drain();
  assert.equal(f.replies.length, 1, 'old session did not open a new card after await');
  f.emit(start(6, 300), OTHER_SESSION); f.emit(goal(3, 301), OTHER_SESSION); await f.drain();
  assert.equal(f.replies.length, 2);
});

const syncedTarget = { channel: 'feishu', botId: 'bot-a', openId: 'ou_owner', targetId: 'owner' };

test('a goal round opened outside the IM shows its progress and result in the bound conversation', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 1, 'the round opens a card in the conversation');
  const opening = f.replies[0];
  assert.equal(opening.path.message_id, 'om-topic-1', 'the card replies to the conversation anchor');
  assert.match(opening.data.content, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(opening.data.content, /goal_round/);
  assert.doesNotMatch(opening.data.content, /Objective:/);

  f.emit(tool());
  await f.drain();
  f.emit(answer('本轮完成：PvE 战斗改为逐回合结算。'));
  await f.drain();
  f.emit(end());
  await f.drain();

  const card = f.cardFor('reply-1');
  assert.match(card, /bash/);
  assert.match(card, /目标自动续跑（第 1 轮）/);
  assert.match(card, /PvE 战斗改为逐回合结算/);
  assert.match(card, /已完成/);
  assert.doesNotMatch(card, /goal_round/);
});

test('each continuation round starts a new card and delivers its own result', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(answer('第一轮结果', 4));
  await f.drain();
  f.emit(end(4));
  await f.drain();

  f.emit(start(5, 200));
  f.emit(goal(2, 205));
  await f.drain();
  f.emit(answer('第二轮结果', 5));
  await f.drain();
  f.emit(end(5, 208));
  await f.drain();

  assert.equal(f.replies.length, 2);
  assert.match(f.replies[0].data.content, /第 1 轮/);
  assert.match(f.replies[1].data.content, /第 2 轮/);
  assert.match(f.cardFor('reply-2'), /第二轮结果/);
});

test('a lost turn/end does not block the next round and closes the stale card', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4));
  await f.drain();
  f.emit(answer('第一轮结果', 4));
  await f.drain();
  // The connection drops here: turn/end for turn 4 never arrives.

  f.emit(start(5, 200));
  f.emit(goal(2, 205));
  await f.drain();
  f.emit(answer('第二轮结果', 5));
  await f.drain();
  f.emit(end(5, 208));
  await f.drain();

  assert.equal(f.replies.length, 2, 'the next round gets its own card');
  assert.match(f.replies[1].data.content, /第 2 轮/);
  assert.match(f.cardFor('reply-1'), /已完成/, 'the orphaned round is sealed, not left open');
  assert.match(f.cardFor('reply-2'), /第二轮结果/);
});

test('a synced DM does not suppress the group topic bound to the same session', async t => {
  const f = await fixture(t, { resolver: async () => [syncedTarget] });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 1, 'the topic still gets its own card');
  assert.equal(f.creates.length, 1, 'the synced DM still gets its mirror card');
  assert.equal(f.creates[0].params?.receive_id_type, 'open_id');
  assert.match(f.replies[0].data.content, /目标自动续跑（第 1 轮）/);
});

test('the synced DM itself is not rendered twice', async t => {
  const f = await fixture(t, {
    resolver: async () => [syncedTarget],
    keys: [[DM, 'ou_owner', 'om-dm-1']],
  });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 0, 'the mirror owns the direct chat');
  assert.equal(f.creates.length, 1, 'only the mirror card exists');
  assert.match(f.creates[0].data.content, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(f.creates[0].data.content, /goal_round/);
});

test('rebinding the conversation stops the old round from writing into it', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(answer('旧会话半截答案', 4));
  await f.drain();

  f.bind(TOPIC, OTHER_SESSION);
  f.emit(answer('旧会话不该出现的结论', 4, 105));
  await f.drain();
  f.emit(end(4, 106));
  await f.drain();

  const card = f.cardFor('reply-1');
  assert.doesNotMatch(card, /旧会话不该出现的结论/);
  assert.match(card, /已完成/, 'the round is closed instead of staying open');
});

const OTHER_TOPIC = 'group:chat-2:thread:thread-2';

test('a goal in one bound conversation does not seal another session\'s running card', async t => {
  const f = await fixture(t, {
    keys: [
      [TOPIC, 'chat-1', 'om-topic-1', SESSION],
      [OTHER_TOPIC, 'chat-2', 'om-topic-2', OTHER_SESSION],
    ],
  });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4, 102));
  await f.drain();

  // Session B starts its own goal while A is still running.
  f.emit(start(4, 299), OTHER_SESSION);
  f.emit(goal(1, 300), OTHER_SESSION);
  await f.drain();

  assert.equal(f.replies.length, 2, 'both conversations open their own card');
  assert.equal(f.replies[0].path.message_id, 'om-topic-1');
  assert.equal(f.replies[1].path.message_id, 'om-topic-2');
  assert.match(f.cardFor('reply-1'), /bash/);
  assert.doesNotMatch(f.cardFor('reply-1'), /已完成/, 'A must stay open while its turn runs');

  f.emit(answer('会话 A 的最终结论', 4, 104));
  await f.drain();
  f.emit(end(4, 105));
  await f.drain();

  assert.match(f.cardFor('reply-1'), /bash/);
  assert.match(f.cardFor('reply-1'), /会话 A 的最终结论/);
  assert.match(f.cardFor('reply-1'), /已完成/);

  f.emit(answer('会话 B 的最终结论', 4, 303), OTHER_SESSION);
  await f.drain();
  f.emit(end(4, 304), OTHER_SESSION);
  await f.drain();

  assert.match(f.cardFor('reply-2'), /会话 B 的最终结论/);
  assert.match(f.cardFor('reply-2'), /已完成/);
  assert.match(f.cardFor('reply-1'), /会话 A 的最终结论/, 'A keeps its result');
});

test('Hermes goal cards preserve tool and terminal errors without cross-turn writes', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit({ type: 'tool/call', seq: 102, data: { turn: 4, callId: 'a', name: 'read', arguments: '{}' } });
  f.emit({ type: 'tool/result', seq: 103, data: { turn: 4, callId: 'a', isError: true } });
  f.emit(answer('其他轮次内容', 3, 104));
  await f.drain();
  assert.match(f.cardFor('reply-1'), /❌ read/);
  assert.doesNotMatch(f.cardFor('reply-1'), /其他轮次内容/);
  f.emit(answer('本轮结果', 4, 105)); f.emit(end(4, 106, 'error')); await f.drain();
  const card = f.cardFor('reply-1');
  assert.match(card, /执行失败/);
  assert.match(card, /本轮结果/);
  assert.doesNotMatch(card, /goal_round|Objective:/);
});

test('a goal in a session with no Feishu conversation leaves bound cards alone', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4, 102));
  await f.drain();

  // A plain `dsh web` session starts a goal; it has no conversation here.
  f.emit(start(9, 499), 'web-only-session');
  f.emit(goal(1, 500), 'web-only-session');
  await f.drain();

  assert.equal(f.replies.length, 1, 'the unbound session opens nothing');
  assert.doesNotMatch(f.cardFor('reply-1'), /已完成/);

  f.emit(answer('飞书会话的结果', 4, 104));
  await f.drain();
  f.emit(end(4, 105));
  await f.drain();

  assert.match(f.cardFor('reply-1'), /bash/);
  assert.match(f.cardFor('reply-1'), /飞书会话的结果/);
  assert.match(f.cardFor('reply-1'), /已完成/);
});

for (const failure of ['opening', 'patch', 'seal']) {
  test(`Hermes goal ${failure} failure delivers the final answer once as topic text`, async t => {
    let failPatch = failure === 'patch';
    const f = await fixture(t, {
      stepPushMode: 'hermes_card',
      rejectReply: request => failure === 'opening' && request.data.msg_type === 'interactive',
      rejectCreate: request => failure === 'opening' && request.data.msg_type === 'interactive',
      rejectPatch: () => failPatch,
    });
    f.emit(start()); f.emit(goal()); await f.drain();
    f.emit(answer('不能丢失的最终答案')); await f.drain();
    if (failure === 'seal') failPatch = true;
    f.emit(end()); await f.drain();
    f.emit(end(4, 105)); await f.drain();
    const texts = f.replies.filter(request => request.data.msg_type === 'text');
    assert.equal(texts.length, 1, 'failed card falls back once, even after duplicate turn/end');
    assert.equal(texts[0].path.message_id, 'om-topic-1');
    assert.deepEqual(JSON.parse(texts[0].data.content), { text: '不能丢失的最终答案' });
    assert.equal(f.creates.filter(request => request.data.msg_type === 'text').length, 0);
    if (failure !== 'opening') assert.ok(f.patches.length > 0, 'a real patch/seal request failed');
  });
}

for (const failure of ['patch', 'seal']) {
  test(`Hermes retries a destination after ${failure} and text fallback both fail`, async t => {
    let fail = true;
    const f = await fixture(t, {
      stepPushMode: 'hermes_card',
      keys: [[TOPIC, 'chat-1', 'om-topic-1'], [OTHER_TOPIC, 'chat-2', 'om-topic-2']],
      rejectPatch: request => fail && request.path.message_id === 'reply-2',
      rejectReply: request => fail && request.path.message_id === 'om-topic-2' && request.data.msg_type === 'text',
      rejectCreate: request => fail && request.data.receive_id === 'chat-2' && request.data.msg_type === 'text',
    });
    const events = [start(), goal(), answer('最终答案'), end()];
    f.emit(events[0]); f.emit(events[1]); await f.drain();
    if (failure === 'seal') fail = false;
    f.emit(events[2]); await f.drain();
    fail = true;
    f.emit(events[3]); await f.drain();
    fail = false;
    for (const event of events) f.emit(event);
    await f.drain();
    const cards1 = f.replies.filter(r => r.path.message_id === 'om-topic-1' && r.data.msg_type === 'interactive');
    const cards2 = f.replies.filter(r => r.path.message_id === 'om-topic-2' && r.data.msg_type === 'interactive');
    assert.equal(cards1.length, 1);
    assert.equal(cards2.length, 2);
    assert.match(f.cardFor(`reply-${f.replies.length}`), /最终答案/);
  });
}

test('Hermes goal text fallback reuses main-chat degradation when the topic rejects text', async t => {
  const f = await fixture(t, {
    stepPushMode: 'hermes_card',
    rejectReply: () => true,
    rejectCreate: request => request.data.msg_type === 'interactive',
  });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit(answer('最终答案主界面兜底')); f.emit(end()); await f.drain();
  const texts = f.creates.filter(request => request.data.msg_type === 'text');
  assert.equal(texts.length, 1);
  assert.deepEqual(JSON.parse(texts[0].data.content), { text: '最终答案主界面兜底' });
});

test('a healthy Hermes goal card delivers its answer without a duplicate text message', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit(answer('只在卡片中的最终答案')); f.emit(end()); await f.drain();
  assert.match(f.cardFor('reply-1'), /只在卡片中的最终答案/);
  assert.match(f.cardFor('reply-1'), /本轮回复已结束/);
  assert.equal(f.replies.length, 1);
  assert.equal(f.creates.length, 0);
});

const goalToolIds = [
  ['callId', { callId: 'a' }, { callId: 'a' }],
  ['subCallId', { callId: ' ', subCallId: 'a' }, { callId: ' ', subCallId: 'a' }],
  ['message.toolCallId', { callId: 'a' }, { callId: 'wrong', message: { toolCallId: 'a', source: { callId: 'wrong' } } }],
  ['block.toolCallId', { callId: 'a' }, { callId: 'wrong', message: { toolCallId: '', source: { callId: 'wrong' }, content: [{ toolCallId: 7 }, { toolCallId: 'a' }] } }],
  ['message.source.callId', { subCallId: 'a' }, { callId: 'wrong', message: { source: { callId: 'a' } } }],
];
for (const [label, callData, resultData] of goalToolIds) {
  test(`Hermes goal matches legitimate ${label} without attributing unknown results`, async t => {
    const f = await fixture(t, { stepPushMode: 'hermes_card' });
    f.emit(start()); f.emit(goal()); await f.drain();
    f.emit({ type: 'tool/call', seq: 101, data: { turn: 4, name: 'read', ...callData } });
    await f.drain();
    assert.match(f.cardFor('reply-1'), /⏳ read/);
    assert.doesNotMatch(f.cardFor('reply-1'), /✅ read/);
    f.emit({ type: 'tool/result', seq: 102, data: { turn: 4, message: { toolCallId: 'unknown' }, isError: true } });
    f.emit({ type: 'tool/result', seq: 103, data: { turn: 4, isError: true } });
    await f.drain();
    assert.match(f.cardFor('reply-1'), /⏳ read/);
    f.emit({ type: 'tool/result', seq: 104, data: { turn: 4, ...resultData } });
    await f.drain();
    assert.match(f.cardFor('reply-1'), /✅ read/);
    assert.doesNotMatch(f.cardFor('reply-1'), /❌ read/);
  });
}

for (const errorData of [
  { error: { name: 'ToolError', code: 'bad', reason: 'denied' } },
  { isError: true },
  { message: { isError: true } },
  { message: { content: [{ type: 'text', text: 'nested failure', isError: true }] } },
]) {
  test(`Hermes goal preserves real tool failure shape ${JSON.stringify(errorData)}`, async t => {
    const f = await fixture(t, { stepPushMode: 'hermes_card' });
    f.emit(start()); f.emit(goal()); await f.drain();
    f.emit({ type: 'tool/call', seq: 101, data: { turn: 4, callId: 'a', name: 'read' } });
    f.emit({ type: 'tool/result', seq: 102, data: { turn: 4, callId: 'a', ...errorData } });
    await f.drain();
    assert.match(f.cardFor('reply-1'), /❌ read/);
    assert.doesNotMatch(f.cardFor('reply-1'), /✅ read/);
    f.emit(end()); await f.drain();
    assert.match(f.cardFor('reply-1'), /❌ read/, 'turn completion must not promote a failed tool');
  });
}

test('Hermes goal ignores unscoped tool results and answers instead of guessing a turn', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card' });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit({ type: 'tool/call', seq: 101, data: { turn: 4, callId: 'a', name: 'read' } });
  f.emit({ type: 'tool/result', seq: 102, data: { callId: 'a', isError: true } });
  // Remove the helper's explicit turn for this malformed frame.
  const unscoped = answer('不应写入的内容', 4, 104);
  delete unscoped.data.turn;
  f.emit(unscoped);
  await f.drain();
  assert.match(f.cardFor('reply-1'), /⏳ read/);
  assert.doesNotMatch(f.cardFor('reply-1'), /❌ read|不应写入的内容/);
});

test('Hermes goal fallback does not send old-session answers after rebinding', async t => {
  const f = await fixture(t, { stepPushMode: 'hermes_card', rejectPatch: () => true });
  f.emit(start()); f.emit(goal()); await f.drain();
  f.emit(answer('旧会话答案')); await f.drain();
  f.bind(TOPIC, OTHER_SESSION);
  f.emit(end()); await f.drain();
  assert.equal(f.replies.filter(request => request.data.msg_type === 'text').length, 0);
  assert.equal(f.creates.filter(request => request.data.msg_type === 'text').length, 0);
});
