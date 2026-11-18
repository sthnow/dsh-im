import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { HermesCardProgress } from '../../../src/channels/feishu/hermes-progress.mjs';

function fixture(ask, { patchFails = false, beforeSend = async () => {}, beforePatch = async () => {} } = {}) {
  let sequence = 0, now = 100000;
  const messages = new Map(), writes = [], posts = [], sessions = new Map(), seen = new Set();
  const emit = async request => {
    const id = `message-${++sequence}`;
    if (request.data.msg_type === 'interactive') {
      const card = JSON.parse(request.data.content);
      await beforeSend(card);
      messages.set(id, card); writes.push(card);
    } else posts.push(request.data.content);
    return { code: 0, data: { message_id: id } };
  };
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: {
      create: emit, reply: emit,
      patch: async request => {
        if (patchFails) throw new Error('patch unavailable');
        const card = JSON.parse(request.data.content);
        await beforePatch(card);
        messages.set(request.path.message_id, card); writes.push(card);
        return { code: 0 };
      },
    } } } },
    channel: { stream: async () => { throw Error('not the legacy stream path'); } },
    harness: { sessionExists: async () => true, createSession: async () => 'session', ask },
    state: { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: key => sessions.get(key), setSession: async (key,id) => sessions.set(key,id), clearSession: async key => sessions.delete(key) },
    status: {}, allowedSenderOpenIds: new Set(['user']), stepPush: true,
    stepPushMode: 'hermes_card', stepCardPanels: { thinkingExpanded: true, toolsExpanded: true },
    stepPushClock: { now: () => now, delay: async ms => { now += Math.max(ms,0); } },
    logger: { warn() {}, info() {}, error() {} },
  });
  const run = async () => {
    await bridge.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: { message_id: 'in', message_type: 'text', chat_type: 'p2p', chat_id: 'chat', content: JSON.stringify({ text: 'test' }) } });
    await bridge.waitForIdle();
  };
  return { run, writes, messages, posts };
}

function assertCompletedCard(card) {
  assert.equal(Object.hasOwn(card, 'header'), false);
  const elements = card.body.elements;
  assert.equal(elements.at(-2).tag, 'hr');
  assert.equal(elements.at(-1).tag, 'markdown');
  assert.equal(elements.at(-1).text_size, 'notation');
  assert.match(elements.at(-1).content, /^✅ 本轮回复已结束(?: · |$)/);
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('expected asynchronous card write');
}

for (const pending of ['send', 'patch']) {
  test(`Hermes flushes updates received during pending ${pending} before turn end`, async () => {
    const entered = deferred(), release = deferred(), finish = deferred();
    let blocked = false, active = 0, maxActive = 0;
    const hold = async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
      active--;
    };
    const f = fixture(async (_id, _text, options) => {
      await options.onUpdate({ type: 'text', step: 0, text: 'first' });
      if (pending === 'patch') {
        await until(() => f.writes.length === 1);
        await options.onUpdate({ type: 'text', step: 0, text: ' second' });
      }
      await entered.promise;
      await options.onUpdate({ type: 'text', step: 0, text: ' newest' });
      await options.onUpdate({ type: 'reasoning', step: 0, text: 'later reasoning' });
      release.resolve();
      await finish.promise;
      return 'final';
    }, pending === 'send' ? { beforeSend: hold, beforePatch: hold } : { beforePatch: hold });
    const running = f.run();
    try {
      await entered.promise;
      await until(() => f.writes.some(card => JSON.stringify(card).includes('later reasoning')));
      const live = f.writes.at(-1);
      assert.match(JSON.stringify(live), /newest/);
      assert.notEqual(live.header.template, 'green');
      const count = f.writes.length;
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.writes.length, count, 'no endless resend without updates');
      assert.equal(maxActive, 1);
    } finally {
      release.resolve(); finish.resolve();
      await running;
    }
    assertCompletedCard(f.writes.at(-1));
    assert.match(JSON.stringify(f.writes.at(-1)), /final/);
    assert.equal(f.posts.length, 0);
  });
}

test('Hermes retracts a failed attempt before the turn ends', async () => {
  const finish = deferred(), cleared = deferred();
  const f = fixture(async (_id, _text, options) => {
    await options.onUpdate({ type: 'text', step: 0, text: 'abandoned draft' });
    await until(() => f.writes.some(card => JSON.stringify(card).includes('abandoned draft')));
    await options.onUpdate({ type: 'text', step: 0, text: '' });
    await until(() => !JSON.stringify(f.writes.at(-1)).includes('abandoned draft'));
    cleared.resolve();
    await finish.promise;
    return 'canonical';
  });
  const running = f.run();
  try {
    await cleared.promise;
    assert.notEqual(f.writes.at(-1).header.template, 'green');
    assert.doesNotMatch(JSON.stringify(f.writes.at(-1)), /abandoned draft/);
  } finally {
    finish.resolve();
    await running;
  }
  assert.match(JSON.stringify(f.writes.at(-1)), /canonical/);
});

test('Hermes seal waits for a pending render and its queued update', async () => {
  const entered = deferred(), release = deferred();
  let patchCount = 0;
  const f = fixture(async (_id, _text, options) => {
    await options.onUpdate({ type: 'text', step: 0, text: 'first' });
    await entered.promise;
    await options.onUpdate({ type: 'text', step: 0, text: ' queued' });
    return 'final';
  }, { beforeSend: async () => { entered.resolve(); await release.promise; }, beforePatch: async () => { patchCount++; } });
  let done = false;
  const running = f.run().then(() => { done = true; });
  await entered.promise;
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  release.resolve();
  await running;
  assert.ok(patchCount >= 2, 'queued live render precedes seal');
  assert.match(JSON.stringify(f.writes.at(-2)), /queued/);
  assertCompletedCard(f.writes.at(-1));
});

test('Hermes-only bridge streams partial text, preserves reasoning, real tool failures and metrics', async () => {
  const f = fixture(async (_id,_prompt,options) => {
    assert.equal(options.hermesCard,true); assert.equal(options.reasoning,true);
    await options.onUpdate({ type:'text',step:0,text:'正在检查' });
    await options.onUpdate({ type:'assistant-message',step:0,text:'正在检查' });
    await options.onUpdate({ type:'reasoning',step:0,text:'真实推理' });
    await options.onUpdate({ type:'tool',callId:'a',name:'read',arguments:'{"path":"a.txt"}' });
    await options.onUpdate({ type:'tool-result',callId:'a',toolName:'read',isError:true,error:'missing file' });
    await options.onUpdate({ type:'text',step:1,text:'最终' });
    await options.onUpdate({ type:'assistant-message',step:1,text:'最终答案' });
    await options.onUpdate({ type:'metrics',inputTokens:100,outputTokens:40,model:'actual-model' });
    await options.onUpdate({ type:'turn-end',reason:{kind:'completed'} });
    return '最终答案';
  });
  await f.run();
  const final = f.writes.at(-1), text=JSON.stringify(final);
  assertCompletedCard(final);
  assert.match(text,/最终答案/); assert.match(text,/真实推理/); assert.match(text,/进度说明/);
  assert.match(text,/❌ read/); assert.doesNotMatch(text,/✅ read/);
  assert.match(text,/100 tokens/); assert.match(text,/actual-model/); assert.doesNotMatch(text,/tokens\/s/);
  assert.equal(final.body.elements.find(e=>e.tag==='collapsible_panel').expanded,true);
  assert.equal(f.posts.length,0);
});

test('Hermes long answers are fully retained in safe card chunks', async () => {
  const answer=Array.from({length:180},(_,i)=>`段落${i}：${'长文本'.repeat(70)}\n\n`).join('');
  const f=fixture(async()=>answer); await f.run();
  const texts=[...f.messages.values()].flatMap(card=>card.body.elements.filter(e=>e.tag==='markdown'&&e.text_size==='normal').map(e=>e.content)).join('');
  // Existing Markdown chunker reopens fences and normalizes paragraph gaps;
  // verify every payload character and its order, not cross-card whitespace.
  assert.equal(texts.replace(/\s/g,''),answer.replace(/\s/g,''));
  for (const card of f.messages.values()) assert.ok(Buffer.byteLength(JSON.stringify(card))<=24000);
});

test('Hermes patch failure falls back with full answer',async()=>{
  const f=fixture(async(_id,_text,options)=>{await options.onUpdate({type:'text',step:0,text:'draft'}); await new Promise(resolve=>setImmediate(resolve)); return 'complete answer';},{patchFails:true});
  await f.run(); assert.match(f.posts.join(''),/complete answer/);
});

test('Hermes interaction freezes history and opens continuation after it', async () => {
  const f=fixture(async(_id,_text,options)=>{
    await options.onUpdate({type:'assistant-message',step:0,text:'before interaction'});
    await new Promise(resolve=>setImmediate(resolve));
    await options.onInteraction({kind:'approval',payload:{}});
    await options.onUpdate({type:'assistant-message',step:1,text:'after interaction'});
    return 'after interaction';
  });
  await f.run();
  const cards=[...f.messages.values()];
  assert.equal(cards.length,2);
  assert.equal(cards[0].header.template,'default');
  assert.doesNotMatch(JSON.stringify(cards[0]),/after interaction/);
  assert.match(JSON.stringify(cards[1]),/after interaction/);
  assertCompletedCard(cards[1]);
});

test('Hermes final delivery keeps the newest canonical step despite late older messages', async () => {
  const f = fixture(async (_id, _text, options) => {
    await options.onUpdate({ type: 'assistant-message', step: 2, text: 'newest answer' });
    await options.onUpdate({ type: 'assistant-message', step: 1, text: 'late older answer' });
    return 'newest answer';
  });
  await f.run();
  const finalCard = JSON.stringify(f.writes.at(-1));
  assert.match(finalCard, /newest answer/);
  assert.doesNotMatch(f.posts.join(''), /late older answer/);
  assertCompletedCard(f.writes.at(-1));
  const fallback = fixture(async (_id, _text, options) => {
    await options.onUpdate({ type: 'assistant-message', step: 2, text: 'newest answer' });
    await options.onUpdate({ type: 'assistant-message', step: 1, text: 'late older answer' });
    return 'newest answer';
  }, { patchFails: true });
  await fallback.run();
  assert.match(fallback.posts.join(''), /newest answer/);
  assert.doesNotMatch(fallback.posts.join(''), /late older answer/);
});

test('Hermes rotation resets note metadata before late older corrections', async () => {
  const f = fixture(async (_id, _text, options) => {
    await options.onUpdate({ type: 'assistant-message', step: 0, text: 'old card note' });
    await options.onUpdate({ type: 'text', step: 1, text: 'before rotation' });
    await options.onUpdate({ type: 'reasoning', step: 1, text: 'old reasoning' });
    await options.onInteraction({ kind: 'approval', payload: {} });
    await options.onUpdate({ type: 'assistant-message', step: 0, text: 'late original' });
    await options.onUpdate({ type: 'assistant-message', step: 0, text: 'late corrected' });
    await options.onUpdate({ type: 'assistant-message', step: 1, text: 'final answer' });
    return 'final answer';
  });
  await f.run();
  const card = JSON.stringify([...f.messages.values()].at(-1));
  assert.match(card, /late corrected/);
  assert.doesNotMatch(card, /late original|old card note|old reasoning/);
  assert.match(card, /final answer/);
});

test('Hermes observed interruption is not sealed as completed', async () => {
  const f=fixture(async(_id,_text,options)=>{
    await options.onUpdate({type:'text',step:0,text:'partial answer'});
    await options.onUpdate({type:'turn-end',reason:{kind:'interrupted'}});
    return 'partial answer';
  });
  await f.run(); assert.equal(f.writes.at(-1).header.template,'red');
  assert.match(JSON.stringify(f.writes.at(-1)),/已停止/);
});

test('Hermes process history remains byte bounded for CJK and escaped text',()=>{
  const p=new HermesCardProgress(()=>1000);
  for(let i=0;i<30;i++) {
    p.consume({type:'text',step:i,text:'汉字'.repeat(600)});
    p.consume({type:'tool',callId:String(i),name:'read'});
    p.consume({type:'reasoning',step:i,text:'推理'.repeat(600)});
  }
  for(const block of p.blocks()) assert.ok(Buffer.byteLength(JSON.stringify(block)) < 6500);
  assert.ok(p.blocks().some(block=>block.omitted>0));
});

test('Hermes progress keeps newer draft when earlier step is replayed or finalized', () => {
  const p = new HermesCardProgress();
  p.consume({ type: 'text', step: 0, text: 'B' });
  p.consume({ type: 'text', step: 1, text: 'NEW' });
  p.consume({ type: 'text', step: 0, text: 'AB' });
  assert.equal(p.draft, 'NEW');
  assert.deepEqual(p.notes, ['AB']);
  p.consume({ type: 'assistant-message', step: 0, text: 'canonical' });
  assert.equal(p.draft, 'NEW');
  assert.deepEqual(p.notes, ['canonical']);
  p.consume({ type: 'text', step: 0, text: '' });
  assert.equal(p.draft, 'NEW');
  assert.deepEqual(p.notes, []);
  p.consume({ type: 'assistant-message', step: 0, text: 'late canonical' });
  assert.equal(p.draft, 'NEW');
  assert.deepEqual(p.notes, ['late canonical']);
  p.consume({ type: 'assistant-message', step: 0, text: 'late canonical corrected' });
  assert.deepEqual(p.notes, ['late canonical corrected']);
  p.consume({ type: 'assistant-message', step: 1, text: 'new canonical' });
  p.consume({ type: 'text', step: 2, text: 'next' });
  assert.equal(p.draft, 'next');
  assert.deepEqual(p.notes, ['late canonical corrected', 'new canonical']);
});

test('Hermes progress never invents success for pending or unmatched tool outcomes',()=>{
  const p=new HermesCardProgress(()=>1000);
  p.consume({type:'tool',callId:'one',name:'read'});
  p.consume({type:'tool-result',callId:'other',isError:false});
  assert.match(JSON.stringify(p.blocks()),/⏳ read/);
  p.finish('stopped'); assert.match(JSON.stringify(p.blocks()),/⏹ read/);
  assert.doesNotMatch(JSON.stringify(p.blocks()),/✅/);
  p.consume({type:'metrics',inputTokens:100}); p.consume({type:'metrics',model:'a'});
  assert.equal(p.metrics.inputTokens,undefined);
});
