import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProductionController } from '../../../plugin-src/host/channels/feishu/production.mjs';
import { StateStore } from '../../../src/channels/feishu/state-store.mjs';

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(t, Store) {
  const dir = await mkdtemp(join(process.cwd(), '.feishu-flight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let options;
  class Controller {
    constructor(value) { options = value; }
    async close() {}
  }
  class ConfigStore { async load() { return this; } }
  class Harness { stopManagedProcess() {} }
  class Runtime { constructor(value) { this.options = value; } }
  const workspaces = {
    async ensure() {}, incarnationFor() { return 1; }, has() { return true; }, accessPolicyFor() {},
    decorateStatus(value) { return value; },
  };
  const production = await createProductionController({
    credentials: {}, typertGateway: { invoke() {}, stream() {} }, logger: console,
  }, { dataDir: dir, dshHome: dir, workspace: dir }, {
    Controller, ConfigStore, StateStore: Store, HarnessClient: Harness,
    FeishuRuntime: Runtime, workspaces, groupHistory: {},
    inboundTtl: { stagingRetention() {}, trackStaged() {} }, proxyEnv: {},
    lark: { registerApp() {} },
    createConnectionSupervisor: () => ({ start: () => ({ ready: Promise.resolve(), close: async () => {} }) }),
  });
  t.after(() => production.close());
  return { dir, create: (config) => options.createRuntime({ config, appSecret: 'test' }) };
}

const bot = (id, secretRef = 'SECRET') => ({ id, appId: `app-${id}`, secretRef });

test('same-path cold callers share one load and retain concurrent writes', async (t) => {
  const started = gate();
  const release = gate();
  const stores = [];
  class GatedStore extends StateStore {
    constructor(path) { super(path); stores.push(this); }
    async load() { started.release(); await release.promise; return super.load(); }
  }
  const { dir, create } = await fixture(t, GatedStore);
  const a = create(bot('alpha'));
  const b = create(bot('alpha'));
  await started.promise;
  assert.equal(stores.length, 1);
  release.release();
  const [first, second] = await Promise.all([a, b]);
  await Promise.all([first.options.state.markSeen('m1'), second.options.state.markSeen('m2')]);
  const disk = JSON.parse(await readFile(join(dir, 'bots', 'alpha', 'state.json'), 'utf8'));
  assert.deepEqual(disk.seenMessageIds, ['m1', 'm2']);
  await create(bot('alpha'));
  assert.equal(stores.length, 1);
});

test('legacy identities sharing a path coalesce; distinct paths load independently', async (t) => {
  const release = gate();
  const started = gate();
  const paths = [];
  class GatedStore extends StateStore {
    constructor(path) { super(path); paths.push(path); if (paths.length === 2) started.release(); }
    async load() { await release.promise; return super.load(); }
  }
  const { dir, create } = await fixture(t, GatedStore);
  const calls = [create(bot('legacy-a', 'DSH_FEISHU_APP_SECRET')),
    create(bot('legacy-b', 'DSH_FEISHU_APP_SECRET')), create(bot('modern'))];
  await started.promise;
  assert.deepEqual(new Set(paths), new Set([resolve(dir, 'state.json'), resolve(dir, 'bots', 'modern', 'state.json')]));
  assert.equal(paths.length, 2);
  release.release();
  await Promise.all(calls);
});

test('failed cold load is shared and a later call retries', async (t) => {
  const started = gate();
  const release = gate();
  const failure = new Error('controlled load failure');
  let count = 0;
  class FailingOnceStore extends StateStore {
    async load() {
      count++;
      if (count === 1) { started.release(); await release.promise; throw failure; }
      return super.load();
    }
  }
  const { create } = await fixture(t, FailingOnceStore);
  const a = create(bot('retry'));
  const b = create(bot('retry'));
  const resultsPromise = Promise.allSettled([a, b]);
  await started.promise;
  assert.equal(count, 1);
  release.release();
  const results = await resultsPromise;
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].reason, failure);
  await create(bot('retry'));
  assert.equal(count, 2);
});
