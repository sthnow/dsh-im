import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

async function deliver(answer) {
  let next = 0;
  const messages = new Map(), posts = [], seen = new Set(), sessions = new Map();
  const send = async ({ data }) => {
    const id = `m${++next}`;
    if (data.msg_type === 'interactive') messages.set(id, data.content);
    else posts.push(data.content);
    return { code: 0, data: { message_id: id } };
  };
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { create: send, reply: send,
      patch: async ({ path, data }) => { messages.set(path.message_id, data.content); return { code: 0 }; },
    } } } },
    channel: { stream: async () => { throw Error('unexpected legacy stream'); } },
    harness: { sessionExists: async () => true, createSession: async () => 'session', ask: async () => answer },
    state: { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: key => sessions.get(key), setSession: async (key, id) => sessions.set(key, id), clearSession: async key => sessions.delete(key) },
    status: {}, allowedSenderOpenIds: new Set(['user']), stepPush: true, stepPushMode: 'hermes_card',
    stepPushClock: { now: () => 100000, delay: async () => {} },
    logger: { warn() {}, info() {}, error() {} },
  });
  await bridge.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: { message_id: 'in', message_type: 'text', chat_type: 'p2p', chat_id: 'chat', content: JSON.stringify({ text: 'test' }) } });
  await bridge.waitForIdle();
  assert.deepEqual(posts, [], 'card delivery should not fall back to post');
  const contents = [...messages.values()];
  for (const content of contents) assert.ok(Buffer.byteLength(content, 'utf8') <= 24000, 'serialized card budget');
  const elements = contents.flatMap(content => JSON.parse(content).body.elements.filter(e => e.tag === 'markdown' && e.text_size === 'normal').map(e => e.content));
  return { contents, elements };
}

test('Hermes long fenced code keeps exact indentation and complete independent fences', async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `    const row${i} = "中😀";`);
  const { contents, elements } = await deliver('```js\n' + lines.join('\n') + '\n```');
  assert.ok(contents.length > 1, 'fixture must span cards');
  const recovered = [];
  for (const text of elements) {
    const match = /^(`{3,}|~{3,})js\n([\s\S]*)\n\1$/.exec(text);
    assert.ok(match, `each block must retain a complete JS fence: ${JSON.stringify(text.slice(0, 60))}`);
    recovered.push(...match[2].split('\n'));
  }
  assert.deepEqual(recovered, lines);
});

test('Hermes long table repeats header and preserves every ordered row across cards', async () => {
  const header = '| 索引 | 内容 |\n| --- | --- |';
  const rows = Array.from({ length: 1000 }, (_, i) => `| ${i} | 数据-${i}-😀 |`);
  const { contents, elements } = await deliver(header + '\n' + rows.join('\n'));
  assert.ok(contents.length > 1, 'fixture must span cards');
  const recovered = [];
  for (const text of elements) {
    assert.ok(text.startsWith(header + '\n'), 'each table segment needs its original header');
    recovered.push(...text.slice(header.length + 1).split('\n'));
  }
  assert.deepEqual(recovered, rows);
});

test('Hermes mixed Unicode and JSON escapes stay byte bounded without loss', async () => {
  const lines = Array.from({ length: 1800 }, (_, i) => `line-${i}: 中文😀 quote=" slash=\\ tab=\t control=\u0001`);
  const { contents, elements } = await deliver(lines.join('\n'));
  assert.ok(contents.length > 1, 'fixture must span cards');
  assert.deepEqual(elements.join('\n').split('\n'), lines);
  assert.ok(elements.every(s => !s.includes('\ufffd')), 'no replacement character');
});
