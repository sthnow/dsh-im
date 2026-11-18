import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionController } from '../../../plugin-src/host/channels/feishu/production.mjs';

const resolved = (profileId, source, environmentKind) => ({ profileId, source, code: 'resolved', environmentKind });
const blocked = (code, environmentKind = 'desktop') => ({ profileId: null, source: null, code, environmentKind });
const cases = [
  ['Desktop current with no env', { desktopProfiles: { current: { name: 'desktop-main' } } }, {}, '', resolved('desktop-main', 'desktopProfiles', 'desktop')],
  ['Desktop current and matching env', { desktopProfiles: { current: { name: 'desktop-main' } } }, { DSH_PROFILE: 'desktop-main' }, '', resolved('desktop-main', 'desktopProfiles', 'desktop')],
  ['Desktop env conflict', { desktopProfiles: { current: { name: 'desktop-main' } } }, { DSH_PROFILE: 'other-profile' }, '', blocked('profile-conflict')],
  ['Desktop missing current cannot use env', { desktopProfiles: {} }, { DSH_PROFILE: 'desktop-main' }, '', blocked('unknown-profile')],
  ['Electron missing service cannot use env', {}, { DSH_PROFILE: 'desktop-main' }, '42.0.0', blocked('unknown-profile')],
  ['Bootstrap missing current cannot use env', { desktopPnpmBootstrap: {} }, { DSH_PROFILE: 'desktop-main' }, '', blocked('unknown-profile')],
  ['Desktop executor missing current cannot use env', { desktopPnpm: {} }, { DSH_PROFILE: 'desktop-main' }, '', blocked('unknown-profile')],
  ['Desktop get service current with no env', { get: (key) => key === 'desktopProfiles' ? { current: { name: 'get-profile' } } : undefined }, {}, '', resolved('get-profile', 'desktopProfiles', 'desktop')],
  ['Desktop service lookup failure cannot use env', { get() { throw new Error('private detail'); } }, { DSH_PROFILE: 'web' }, '', blocked('profile-service-unavailable')],
  ['Desktop current getter failure cannot use env', { desktopProfiles: { get current() { throw new Error('private detail'); } } }, { DSH_PROFILE: 'web' }, '', blocked('profile-service-unavailable')],
  ['Desktop invalid current cannot use env', { desktopProfiles: { current: { name: '../invalid' } } }, { DSH_PROFILE: 'web' }, '', blocked('unknown-profile')],
  ['CLI uses host env', {}, { DSH_PROFILE: 'web' }, '', resolved('web', 'host-env', 'cli')],
  ['CLI no env is diagnosed', {}, {}, '', blocked('unknown-profile', 'cli')],
];

// Historical resolver cases below are retained, but production never reads it.
const productionNamespaces = new Set();
// These invoke the real production factory, not a replacement namespace generator.
for (const [name, services, env, electron, expected] of cases) {
  test(`production assembly namespace independent of profile: ${name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hfc-profile-assembly-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let factory;
    class Controller {
      constructor(options) { factory = options.createRuntime; }
      status() { return { totals: { configured: 0, connected: 0 } }; }
      async close() {}
    }
    class ConfigStore { async load() { return this; } }
    class Harness { stopManagedProcess() {} }
    class Runtime { constructor(options) { Object.assign(this, options); } }
    let profileReads = 0;
    const context = { credentials: {}, typertGateway: { invoke() {}, stream() {} }, ...services };
    // Any access to the former profile sources is a production regression.
    for (const key of ['desktopProfiles', 'desktopPnpmBootstrap', 'desktopPnpm']) {
      Object.defineProperty(context, key, { get() { profileReads++; throw Error('production must not resolve profile'); } });
    }
    context.get = key => {
      if (['desktopProfiles', 'desktopPnpmBootstrap', 'desktopPnpm'].includes(key)) {
        profileReads++; throw Error('production must not resolve profile');
      }
      return undefined;
    };
    const production = await createProductionController(context, { dataDir: directory, workspace: directory }, {
      Controller, ConfigStore, HarnessClient: Harness, FeishuRuntime: Runtime,
      profileEnv: env, electron, proxyEnv: {},
      createConnectionSupervisor: () => ({ start() { return { ready: Promise.resolve(), async close() {} }; } }),
    });
    t.after(() => production.close());
    const runtime = await factory({ config: { appId: 'assembly-app', ownerOpenId: 'owner', domain: 'feishu' }, appSecret: 'test-only' });
    assert.match(runtime.hfcRuntimeNamespace, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(Object.hasOwn(runtime, 'profileId'), false);
    assert.equal(Object.hasOwn(runtime, 'profileIdentity'), false);
    const rebuilt = await factory({ config: { appId: 'assembly-app', ownerOpenId: 'owner', domain: 'feishu' }, appSecret: 'test-only' });
    assert.notEqual(rebuilt.hfcRuntimeNamespace, runtime.hfcRuntimeNamespace);
    for (const created of [runtime, rebuilt]) {
      assert.equal(productionNamespaces.has(created.hfcRuntimeNamespace), false, 'different factories and runtimes do not reuse namespace');
      productionNamespaces.add(created.hfcRuntimeNamespace);
    }
    assert.equal(profileReads, 0);
    // Profile changes cannot supply or pin a runtime display namespace.
    if (name === 'Desktop current with no env') {
      const previous = services.desktopProfiles.current;
      try {
        services.desktopProfiles.current = { name: 'next-profile' };
        const next = await factory({ config: { appId: 'next-app', ownerOpenId: 'owner', domain: 'feishu' }, appSecret: 'test-only' });
        assert.notEqual(next.hfcRuntimeNamespace, runtime.hfcRuntimeNamespace);
        assert.notEqual(next.hfcRuntimeNamespace, rebuilt.hfcRuntimeNamespace);
      } finally {
        services.desktopProfiles.current = previous;
      }
    }
  });
}

for (const [name, services, env, electron, expected] of cases) {
  test(`profile resolver: ${name}`, async () => {
    const { resolveHfcProfileIdentity } = await import('../../../plugin-src/host/channels/feishu/hfc-profile-identity.mjs');
    assert.deepEqual(resolveHfcProfileIdentity(services, { env, electron }), expected);
  });
}

test('profile resolver uses supported get lookup and does not trust shadow direct services', async () => {
  const { resolveHfcProfileIdentity } = await import('../../../plugin-src/host/channels/feishu/hfc-profile-identity.mjs');
  const ctx = {
    get: (key) => key === 'desktopProfiles' ? { current: { name: 'trusted' } } : undefined,
    desktopProfiles: { current: { name: 'shadow' } },
  };
  assert.deepEqual(resolveHfcProfileIdentity(ctx, { env: {}, electron: '' }), resolved('trusted', 'desktopProfiles', 'desktop'));
});

test('profile resolver handles failed service access without throwing or using env', async () => {
  const { resolveHfcProfileIdentity } = await import('../../../plugin-src/host/channels/feishu/hfc-profile-identity.mjs');
  assert.deepEqual(resolveHfcProfileIdentity({ get() { throw new Error('private detail'); } }, { env: { DSH_PROFILE: 'web' }, electron: '' }), blocked('profile-service-unavailable'));
  const desktopProfiles = { get current() { throw new Error('private detail'); } };
  assert.deepEqual(resolveHfcProfileIdentity({ desktopProfiles }, { env: {}, electron: '' }), blocked('profile-service-unavailable'));
});

test('profile names preserve exact identity and enforce path/control/byte boundaries', async () => {
  const { resolveHfcProfileIdentity } = await import('../../../plugin-src/host/channels/feishu/hfc-profile-identity.mjs');
  for (const name of ['', '.', '..', 'node_modules', '-option', '../escape', 'a\\b', 'a/b', 'a\nname', 'a\u0000b', 'a\u007fb', 'a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'x'.repeat(256), '智'.repeat(86)]) {
    assert.deepEqual(resolveHfcProfileIdentity({}, { env: { DSH_PROFILE: name }, electron: '' }), blocked('unknown-profile', 'cli'), JSON.stringify(name));
    assert.deepEqual(resolveHfcProfileIdentity({ desktopProfiles: { current: { name } } }, { env: { DSH_PROFILE: 'valid-env' }, electron: '' }), blocked('unknown-profile'), JSON.stringify(name));
  }
  for (const name of ['web', 'desktop', 'profile_1.2', ' profile ', 'x'.repeat(255), '智'.repeat(85)]) {
    assert.deepEqual(resolveHfcProfileIdentity({}, { env: { DSH_PROFILE: name }, electron: '' }), resolved(name, 'host-env', 'cli'));
  }
  assert.deepEqual(resolveHfcProfileIdentity({ desktopProfiles: { current: { name: 'valid' } } }, { env: { DSH_PROFILE: '../invalid' }, electron: '' }), blocked('profile-conflict'));
});

for (const backend of ['default', 'legacy']) {
  test(`real production controller connects ${backend} bot despite unresolved Desktop profile`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hfc-profile-legacy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bot = { id: 'profile-bot', appId: 'profile-app', secretRef: 'PROFILE_TEST_SECRET', ownerOpenIds: ['owner'], domain: 'feishu', ...(backend === 'legacy' ? { hfcPresentation: { backend: 'legacy' } } : {}) };
    await writeFile(join(directory, 'config.json'), JSON.stringify({ version: 2, bots: [bot] }));
    let runtimeOptions;
    class Runtime {
      constructor(options) { runtimeOptions = options; }
      status = { ready: false, feishuLongConnectionState: 'idle', harnessReachable: false };
      async start() { this.status = { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true }; }
      async stop() { this.status.ready = false; }
    }
    class Harness { async ensureRunning() {} stopManagedProcess() {} }
    const production = await createProductionController({
      credentials: { async resolve() { return { value: 'test-only' }; } },
      typertGateway: { invoke() {}, stream() {} }, desktopProfiles: {},
    }, { dataDir: directory, workspace: directory }, {
      lark: { registerApp: async () => ({}) }, HarnessClient: Harness, FeishuRuntime: Runtime,
      verifyFeishuApp: async () => ({}), profileEnv: { DSH_PROFILE: 'must-not-fallback' }, electron: '', proxyEnv: {},
    });
    t.after(() => production.close());
    await production.ready;
    assert.match(runtimeOptions.hfcRuntimeNamespace, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(runtimeOptions, 'profileId'), false);
    assert.equal(Object.hasOwn(runtimeOptions, 'profileIdentity'), false);
    assert.equal((await production.controller.status()).totals.connected, 1);
  });
}
