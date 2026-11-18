import test from 'node:test';
import assert from 'node:assert/strict';
import { recordHfcDiagnostic, hfcDiagnosticFacts, hfcIdentityError, hfcProviderError } from '../../../src/channels/feishu/hfc-diagnostics.mjs';
import { classifyMessageFailure } from '../../../src/channels/shared/message-failure.mjs';
import { FeishuRuntime } from '../../../src/channels/feishu/feishu-runtime.mjs';
import { createHfcDiagnosticRecorder } from '../../../plugin-src/host/channels/feishu/hfc-diagnostic-recorder.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HFC diagnostic helper has a deterministic 250ms deadline and consumes late rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectRecord, finished = false, captured;
  const task = recordHfcDiagnostic({ stage: 'worker', error: Object.assign(Error('PRIVATE'), { code: 'worker-timeout' }),
    identity: { source: 'desktopProfiles', profileId: 'PRIVATE_PROFILE' },
    record: (...args) => { captured = args; return new Promise((_resolve, reject) => { rejectRecord = reject; }); },
  }).then(() => { finished = true; });
  await Promise.resolve();
  t.mock.timers.tick(249); await Promise.resolve(); assert.equal(finished, false);
  t.mock.timers.tick(1); await task; assert.equal(finished, true);
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/);
  rejectRecord(Error('late recorder failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('HFC diagnostics tolerate synchronous recorder and logger throws', async () => {
  await recordHfcDiagnostic({ stage: 'ask', logger: { warn() { throw Error('logger'); } }, record() { throw Error('recorder'); } });
});

test('HFC runtime.start only runs for HFC and recorder reread preserves the same safe identity facts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hfc-start-facts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'diagnostics.json'), record = createHfcDiagnosticRecorder(path);
  for (const backend of ['legacy', 'hfc']) {
    const logs = [], calls = [];
    const runtime = new FeishuRuntime({ lark: {}, appId: 'app', appSecret: 'PRIVATE_SECRET',
      ownerOpenIds: ['user'], harness: { ensureRunning: async () => { throw Error('harness unavailable'); } },
      state: {}, hfcPresentation: { backend, testSessionIds: ['session-test'] },
      hfcRuntimeNamespace: '11111111-1111-4111-8111-111111111111',
      logger: { warn: (tag, facts) => { if (tag === '[dsh-feishu-hfc]') logs.push(JSON.parse(facts)); }, error() {}, info() {} },
      hfcDiagnostic: (...args) => { calls.push(hfcDiagnosticFacts(...args)); return record(...args); },
    });
    await assert.rejects(runtime.start());
    await runtime.stop();
    assert.equal(calls.length, backend === 'hfc' ? 1 : 0);
    assert.deepEqual(logs, calls);
    if (backend === 'hfc') {
      const expected = { stage: 'runtime.start', code: 'hfc-runtime-start', namespaceScope: 'runtime', namespaceSource: 'runtime-random', namespaceCode: 'ready' };
      assert.deepEqual(calls, [expected]);
      // A second append forces the production recorder to re-sanitize its saved rows.
      await record('ask', { code: 'worker-exited' });
      const rows = JSON.parse(await readFile(path, 'utf8'));
      const first = rows[0]; delete first.at;
      assert.deepEqual(first, expected);
      assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
    }
  }
});
test('HFC diagnostics retain safe failure stages and numeric provider codes, never exception text', () => {
  const error=Object.assign(new Error('PRIVATE_PROMPT token=SECRET'),{code:'EVIL_CODE',stack:'PRIVATE_STACK',response:{status:403,data:{code:230099,msg:'SECRET'}}});
  const facts=hfcDiagnosticFacts('card.patch',error,{scope:'runtime',source:'runtime-random',code:'unavailable',runtimeNamespace:'PRIVATE_NAMESPACE',profileId:'PRIVATE_PROFILE'});
  assert.deepEqual(facts,{stage:'card.patch',code:'hfc-operation-failed',providerCode:'230099',httpStatus:403,namespaceScope:'runtime',namespaceSource:'runtime-random',namespaceCode:'unavailable'});
  assert.doesNotMatch(JSON.stringify(facts),/SECRET|PRIVATE/);
});
test('explicit provider rejection is not an unknown delivery retry',()=>{
 const error=hfcProviderError({code:230099,msg:'sensitive provider echo'});
 const failure=classifyMessageFailure(error);
 assert.equal(failure.code,'CHANNEL_DELIVERY');
 assert.equal(failure.details.providerCode,'230099');
 assert.equal(failure.details.stage,'message.send');
 assert.doesNotMatch(JSON.stringify(failure),/sensitive provider echo/);
});
test('identity failure has a safe pre-submit diagnostic, not fabricated submission',()=>{
 const error=hfcIdentityError(true);assert.equal(error.code,'HFC_RUNTIME_NAMESPACE_UNAVAILABLE');
 const failure=classifyMessageFailure(error);assert.equal(failure.reason,'HFC_RUNTIME_NAMESPACE_UNAVAILABLE');
 assert.equal(failure.details.reason,'invalid-config');assert.equal(failure.details.submissionState,'not-submitted');
});
