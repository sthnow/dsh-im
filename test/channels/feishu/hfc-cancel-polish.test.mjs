import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { DshHfcAdapter, HfcWorker } from '../../../src/channels/feishu/hfc/adapter.mjs';
import { VerifiedFeishuChannel } from '../../../src/channels/feishu/feishu-channel.mjs';

const python = process.env.DSH_HFC_TEST_PYTHON;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); } assert.fail('reaction did not settle'); }
const find = (value, predicate) => {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) { const result = find(child, predicate); if (result) return result; }
  return null;
};
const incoming = (id, text) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: {
  message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: 'chat', content: JSON.stringify({ text }),
} });
function fixture({ stop = async () => true, ask = async () => 'done', legacy = false, delivery = 'ok' } = {}) {
  const writes = [], reactions = [], removed = [], responses = [], adapters = [], native = [];
  const seen = new Set(); let sequence = 0, askCount = 0;
  const send = async request => {
    if (request.data.msg_type === 'text' && delivery === 'throw') throw Error('stop acknowledgement failed');
    const id = `out-${++sequence}`;
    writes.push({ id, type: request.data.msg_type, card: JSON.parse(request.data.content) });
    return { code: 0, data: request.data.msg_type === 'text' && delivery === 'missing-id' ? {} : { message_id: id } };
  };
  const client = { im: { v1: { message: { create: send, reply: send, patch: async request => {
      writes.push({ id: request.path.message_id, type: 'interactive', card: JSON.parse(request.data.content) }); return { code: 0 };
    } }, messageReaction: {
      create: async request => { const id = request.path.message_id, emoji = request.data.reaction_type.emoji_type;
        reactions.push({ id, emoji }); return { code: 0, data: { reaction_id: `${id}-${emoji}` } }; },
      delete: async request => { removed.push(request.path.message_id); return { code: 0 }; },
    } } } };
  const channel = new VerifiedFeishuChannel({ client });
  channel.stream = async (_chat, handlers) => { await handlers.markdown({ setContent: async text => native.push(text) });
    return { messageId: 'native', providerMessageIds: ['native'] }; };
  const bridge = new FeishuHarnessBridge({ client, channel,
    harness: { sessionExists: async () => true, workspaceSession: () => ({ stopActiveTurn: stop, sessionExists: async () => true,
      ask: async (_text, options) => { askCount++; return ask(options, responses); } }),
      ask: async (_id, _text, options) => { askCount++; return ask(options, responses); } },
    state: { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: () => 'session-test' },
    status: {}, allowedSenderOpenIds: new Set(['user']), botId: 'bot-test',
    hfcRuntimeNamespace: '11111111-1111-4111-8111-111111111111', stepPush: true, stepPushMode: 'hermes_card',
    hfcPresentation: { backend: legacy ? 'legacy' : 'hfc', testSessionIds: ['session-test'] },
    hfcAdapterFactory: config => { const adapter = new DshHfcAdapter({ ...config, worker: new HfcWorker({ python }), minPatchIntervalMs: 0, minRenderIntervalMs: 0 }); adapters.push(adapter); return adapter; },
    logger: { warn() {}, error() {}, info() {} },
  });
  const emojis = id => reactions.filter(r => r.id === id).map(r => r.emoji);
  return { bridge, writes, removed, responses, native, adapters, emojis, get askCount() { return askCount; },
    async run(text = '/stop', id = 'stop') { await bridge.accept(incoming(id, text)); await bridge.waitForIdle(); } };
}
for (const scenario of [
  { name: 'successful HFC stop clears processing only', expected: ['OnIt'] },
  { name: 'normally returned no-task stop retains legacy command DONE', stop: async () => false, expected: ['OnIt', 'DONE'] },
  { name: 'stop exception is ERROR', stop: async () => { throw Error('stop failed'); }, expected: ['OnIt', 'ERROR'] },
  { name: 'stop acknowledgement send failure is ERROR', delivery: 'throw', expected: ['OnIt', 'ERROR'] },
  { name: 'stop acknowledgement missing ID is ERROR', delivery: 'missing-id', expected: ['OnIt', 'ERROR'] },
  { name: 'successful legacy stop retains DONE', legacy: true, expected: ['OnIt', 'DONE'] },
  { name: 'HFC stop usage is not a stopped task', text: '/stop extra', expected: ['OnIt', 'DONE'] },
  { name: 'other HFC control command retains DONE', text: '/version', expected: ['OnIt', 'DONE'] },
]) test(scenario.name, async () => {
  const f = fixture(scenario); await f.run(scenario.text);
  await until(() => f.removed.includes('stop'));
  assert.deepEqual(f.emojis('stop'), scenario.expected); assert.equal(f.askCount, 0); assert.equal(f.adapters.length, 0);
});

test('actual Bridge /stop plus real Python rail rejects old callback without second respond/native/duplicate', { skip: !python }, async () => {
  const ready = deferred(), stopped = deferred(), resolved = deferred(), finish = deferred();
  let activeOptions;
  const f = fixture({
    stop: async () => { stopped.resolve(); await resolved.promise; return true; },
    ask: async (options, responses) => {
      activeOptions = options;
      await options.onUpdate({ type: 'turn-start', turn: 73 });
      await options.onInteraction({ kind: 'question', interactionId: 'question', rpcId: 'rpc', sessionId: 'session-test',
        payload: { sessionId: 'session-test', questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }] },
        respond: async response => { responses.push(response); return { accepted: true }; } });
      ready.resolve(); await stopped.promise;
      await options.onInteractionResolved({ kind: 'question', interactionId: 'question', sessionId: 'session-test' });
      resolved.resolve(); await finish.promise;
      await options.onUpdate({ type: 'turn-end', turn: 73, reason: { kind: 'cancelled' } });
      return 'stopped turn';
    },
  });
  const running = f.bridge.accept(incoming('original', 'ask'));
  await Promise.race([ready.promise, running.then(() => { throw Error(`turn ended before rail: asks=${f.askCount}, writes=${JSON.stringify(f.writes)}`); })]);
  const rail = f.writes.findLast(w => !w.card.schema), main = f.writes.find(w => w.card.schema);
  const value = find(rail.card, n => n.value?.hfc_action === 'interaction.select').value;
  const callback = () => f.bridge.onCardAction({ operator: { open_id: 'user' },
    context: { open_message_id: rail.id, open_chat_id: 'chat' }, action: { value } });
  await f.bridge.accept(incoming('stop', '/stop'));
  await until(() => f.removed.includes('stop'));
  assert.deepEqual(f.emojis('stop'), ['OnIt']);
  const ended = f.writes.findLast(w => w.id === rail.id).card;
  assert.match(JSON.stringify(ended), /此交互已结束/);
  assert.doesNotMatch(JSON.stringify(ended), /resolved-on-another-client|interaction\.select|hfc_other_/);
  const count = f.writes.length;
  await callback(); await callback();
  assert.equal(f.responses.length, 0); assert.equal(f.writes.length, count, 'revoked callback cannot trigger any new delivery');
  assert.equal(f.askCount, 1); assert.equal(f.native.length, 0);
  finish.resolve(); await running; await f.bridge.waitForIdle();
  assert.equal(f.adapters[0].closed, true);
  await callback(); assert.equal(f.responses.length, 0);
  assert.equal(f.writes.filter(w => !w.card.schema && w.type === 'interactive').length, 2, 'one rail create and one terminal patch');
  assert.equal(new Set(f.writes.filter(w => w.type === 'interactive').map(w => w.id)).size, 2, 'only main and rail messages');
  assert.ok(main); assert.equal(f.native.length, 0); assert.equal(f.askCount, 1);
  assert.ok(activeOptions); assert.deepEqual(f.emojis('original'), ['OnIt', 'ERROR'], 'stopped turn itself is not success');
});

for (const [error, label] of [
  ['resolved-on-another-client', '此交互已结束'], ['interaction-expired', '交互已过期'], ['expired', '交互已过期'],
  ['cancelled', '交互已取消'], ['canceled', '交互已取消'], ['error', '交互处理失败'], ['unknown-code', 'unknown-code'],
]) test(`real worker maps only display error ${error}; wire/state/answers unchanged`, { skip: !python }, () => {
  const worker = fileURLToPath(new URL('../../../assets/hfc/worker.py', import.meta.url));
  const code = `import importlib.util,json,sys,copy\nspec=importlib.util.spec_from_file_location('w',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nw=m.Worker()\ndef event(name,data,seq):\n return {'schema_version':'1','event':name,'conversation_id':'s','message_id':'7','chat_id':'c','platform':'feishu','turn_id':'7','sequence':seq,'created_at':1700000000+seq,'data':data}\nframes=[]\nfor i,(name,data) in enumerate([('message.started',{}),('answer.delta',{'text':sys.argv[2]}),('interaction.requested',{'interaction_id':'q','kind':'clarify','prompt':sys.argv[2],'options':[{'label':sys.argv[2],'value':sys.argv[2]}]}),('interaction.failed',{'interaction_id':'q','error':sys.argv[2]})],1):\n r=w.handle({'id':i,'op':'event','event':event(name,data,i)});assert r['ok'],r;frames.append(r)\ns=next(iter(w.sessions.values()));before=copy.deepcopy(s);d=m.interaction_display_session(s)\nassert s.active_interaction.error==sys.argv[2]\nassert s.answer_text==sys.argv[2]\nassert frames[-1]['summary']['interaction']['error']==sys.argv[2]\nassert frames[-1]['summary']['answer']==sys.argv[2]\ns.active_interaction.status='completed';s.active_interaction.choice_label=sys.argv[2]\nassert m.interaction_display_session(s) is s\nprint(json.dumps({'card':frames[-1]['interaction_card'],'main':frames[-1]['card']}))`;
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', code, worker, error], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const response = JSON.parse(result.stdout);
  assert.equal(response.card.elements.at(-1).content, label);
  assert.ok(JSON.stringify(response.main).includes(error), 'identical user answer is never globally replaced');
});
