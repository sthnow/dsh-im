import { getGroupHistoryStore } from '../../group-history-runtime.mjs';
import { getImageInputSettingsStore } from '../../../../src/channels/shared/image-input-settings-store.mjs';
import { t } from '../../../../src/channels/shared/i18n.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalStatePath } from '../../../../src/channels/feishu/state-coordination.mjs';
import * as Lark from '@larksuiteoapi/node-sdk';
import HttpsProxyAgent from 'https-proxy-agent';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { randomUUID } from 'node:crypto';
import { createHfcDiagnosticRecorder } from './hfc-diagnostic-recorder.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';
import { verifyFeishuApp } from '../../../../src/channels/feishu/feishu-app.mjs';
import { FeishuRuntime } from '../../../../src/channels/feishu/feishu-runtime.mjs';
import { HarnessClient } from '../../../../src/channels/feishu/harness-client.mjs';
import {
  LEGACY_FEISHU_SECRET_REF,
  PluginConfigStore,
} from '../../../../src/channels/feishu/plugin-config-store.mjs';
import { MultiBotDshFeishuController } from '../../../../src/channels/feishu/multi-bot-controller.mjs';
import { StateStore } from '../../../../src/channels/feishu/state-store.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { prepareBotWorkspace } from '../../../../src/channels/shared/default-workspace.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createSessionSyncTargetsFor } from '../../session-sync-targets.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
  newBotAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

// The WebSocket agent built here is only used for the Feishu long connection,
// whose endpoint is open.feishu.cn (Feishu) or open.larksuite.com (Lark).
// Honor NO_PROXY/no_proxy for those hosts so users with blanket proxy
// environments exported in their shell (Clash/V2Ray etc.) keep a direct
// connection to Feishu instead of routing the WSS handshake through the proxy.
const LONG_CONNECTION_HOSTS = ['open.feishu.cn', 'open.larksuite.com'];

function hostExcludedByNoProxyEntry(host, entry) {
  if (entry === '*') return true;
  const bare = entry.startsWith('.') ? entry.slice(1) : entry;
  if (!bare) return false;
  return host === bare || host.endsWith(`.${bare}`);
}

function longConnectionExcludedByNoProxy(env) {
  for (const key of ['no_proxy', 'NO_PROXY']) {
    const value = env?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const entries = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (LONG_CONNECTION_HOSTS.some((host) => entries.some((entry) => hostExcludedByNoProxyEntry(host, entry)))) {
      return true;
    }
  }
  return false;
}

function webSocketProxyUrl(env) {
  if (longConnectionExcludedByNoProxy(env)) return undefined;
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function createFeishuWebSocketAgent(
  env,
  createAgent = (url) => new HttpsProxyAgent(url),
) {
  const proxyUrl = webSocketProxyUrl(env);
  return proxyUrl ? createAgent(proxyUrl) : undefined;
}

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome
    ?? process.env.DSH_HOME
    ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-feishu'));
  return {
    root,
    config: resolve(config.configPath ?? join(root, 'config.json')),
    legacyState: resolve(config.statePath ?? join(root, 'state.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
  };
}

/**
 * Assemble the production controller from DSH Host services and local plugin
 * classes. No bridge process or environment App credentials are required.
 */
export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-feishu requires ctx.credentials');
  const connection = harnessConnection(ctx, config, { competitiveApprovals: true });

  const lark = internals.lark ?? Lark;
  const Controller = internals.Controller ?? MultiBotDshFeishuController;
  const ConfigStore = internals.ConfigStore ?? PluginConfigStore;
  const SessionStateStore = internals.StateStore ?? StateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Runtime = internals.FeishuRuntime ?? FeishuRuntime;
  const verify = internals.verifyFeishuApp ?? verifyFeishuApp;
  const verifyApp = (options) => verify({
    ...options,
    httpInstance: lark.defaultHttpInstance,
  });
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-feishu')
    : (ctx.logger ?? console);
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace, ungroupedWorkspace, groupByAgentPreset: config.groupByAgentPreset }).load();
  const canListConfiguredBots = typeof configStore.list === 'function';
  const listConfiguredBots = () => canListConfiguredBots ? configStore.list() : [];
  const configuredBots = listConfiguredBots();
  if (canListConfiguredBots) {
    await workspaces.reconcile(configuredBots.map((bot) => bot.id));
  }
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.id, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('feishu', bot),
  })));
  const observedConfigStore = typeof configStore.removeBot === 'function'
    ? observeBotWorkspaceRemovals(configStore, {
        workspaces,
        method: 'removeBot',
        botIdFromRemoved: (removed) => removed.id,
        saveMethod: 'saveBot',
        botIdFromSave: (bot) => bot?.id,
      })
    : configStore;
  // State is lazy per bot. A corrupt legacy file can therefore fail only the
  // migrated bot and cannot prevent healthy v2 bots from starting.
  const stateStores = new Map();
  // Factory-local tombstones deliberately never reopen: without a durable binding
  // generation a later bot with the same id cannot safely be distinguished.
  const retiredBots = new Set();
  const bindings = new Map();
  const mutators = new Set(['putDeferred', 'patchDeferred', 'removeDeferred', 'setMirror', 'clearMirror', 'flush', 'setSession', 'clearSession', 'clearSessions', 'markSeen', 'setWatch', 'removeWatch', 'clearWatches', 'setTopic', 'setIncludeArchivedSessions']);
  const readers = new Set(['deferredEntries', 'mirrorEntries', 'sessionFor', 'hasSeen', 'snapshot', 'watchEntries', 'watchEntry', 'keysWatching', 'watchedSessionIds', 'topicRootFor', 'includesArchivedSessions']);
  const retiredError = () => Object.assign(new Error('Feishu state binding is retired'), { code: 'FEISHU_STATE_RETIRED' });
  const isV2 = (bot) => !!bot?.id && !!bot.secretRef && bot.secretRef !== LEGACY_FEISHU_SECRET_REF;
  function retire(botId) {
    retiredBots.add(botId);
    const binding = bindings.get(botId);
    if (binding) binding.retired = true;
  }
  // Read-only preflight: rejection must not retire a usable binding. Legacy
  // state may be shared; its cleanup below preserves other configured owners.
  function validateStateDeletion(botConfig) {
    if (!isV2(botConfig)) return;
    const key = stateKeyFor(resolve(statePathFor(botConfig)));
    const binding = bindings.get(botConfig.id);
    if (binding && (binding.key !== key || binding.secretRef !== botConfig.secretRef || binding.appId !== botConfig.appId)) {
      throw new Error('Cannot safely delete a rebound Feishu state');
    }
    if (!canListConfiguredBots || listConfiguredBots().some((other) => other.id !== botConfig.id && stateKeyFor(resolve(statePathFor(other))) === key)) {
      throw new Error('Cannot safely delete shared Feishu state');
    }
  }
  function facadeFor(store, binding) {
    // Preserve reference identity for each underlying mirror version without
    // exposing the store's mutable objects to callers.
    const mirrorSnapshots = new WeakMap();
    function freezeSnapshot(value, seen = new WeakSet()) {
      if (!value || typeof value !== 'object' || seen.has(value)) return value;
      seen.add(value);
      for (const child of Object.values(value)) freezeSnapshot(child, seen);
      return Object.freeze(value);
    }
    return new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (mutators.has(property)) return (...args) => {
          if (binding.retired) return Promise.reject(retiredError());
          // StateStore retains the supplied mirror object, so detach it before
          // storing; later caller mutations must not bypass persistence.
          const callArgs = property === 'setMirror' ? [args[0], structuredClone(args[1])] : args;
          const result = value.apply(target, callArgs);
          if (result && typeof result.then === 'function') {
            const pending = Promise.resolve(result);
            binding.pending.add(pending);
            pending.then(() => binding.pending.delete(pending), () => binding.pending.delete(pending));
          }
          return result;
        };
        if (readers.has(property)) return (...args) => {
          if (binding.retired) throw retiredError();
          const result = value.apply(target, args);
          if (property === 'mirrorEntries') return result.map(([key, entry]) => {
            if (!entry || typeof entry !== 'object') return [key, entry];
            let snapshot = mirrorSnapshots.get(entry);
            if (!snapshot) {
              snapshot = freezeSnapshot(structuredClone(entry));
              mirrorSnapshots.set(entry, snapshot);
            }
            return [key, snapshot];
          });
          return result && typeof result === 'object' ? structuredClone(result) : result;
        };
        // Unknown methods are not assumed read-only; load and future mutators
        // must not provide a route around retirement or drain tracking.
        return () => { throw new Error(`Unsupported Feishu state method: ${String(property)}`); };
      },
      set() { throw new Error('Feishu state facade is read-only'); },
    });
  }
  const statePathFor = (botConfig) => !botConfig.id
    || !botConfig.secretRef
    || botConfig.secretRef === LEGACY_FEISHU_SECRET_REF
    ? paths.legacyState
    : resolve(paths.bots, botConfig.id, 'state.json');
  // Paths, rather than bot IDs, identify the file: legacy bots may share it.
  // Windows paths are case-insensitive in the supported default filesystem.
  const stateKeyFor = (path) => canonicalStatePath(path);
  const retirementHandles = new Map();
  const stateFor = (botConfig) => {
    const statePath = resolve(statePathFor(botConfig));
    const stateKey = stateKeyFor(statePath);
    let binding;
    if (isV2(botConfig)) {
      if (retiredBots.has(botConfig.id)) throw retiredError();
      binding = bindings.get(botConfig.id);
      if (binding && (binding.key !== stateKey || binding.secretRef !== botConfig.secretRef || binding.appId !== botConfig.appId)) {
        retire(botConfig.id);
        throw new Error('Cannot safely rebind Feishu state');
      }
      if (!binding) {
        binding = { key: stateKey, secretRef: botConfig.secretRef, appId: botConfig.appId, retired: false, pending: new Set() };
        bindings.set(botConfig.id, binding);
      }
    }
    let loading = stateStores.get(stateKey);
    if (!loading) {
      // Register the promise before starting asynchronous I/O; all cold callers
      // then share both the load and the resulting store/write queue.
      loading = Promise.resolve().then(async () => {
        const store = new SessionStateStore(statePath);
        try { return await store.load(); }
        catch (error) { await store.close?.(); throw error; }
      });
      stateStores.set(stateKey, loading);
      loading.catch(() => {
        if (stateStores.get(stateKey) === loading) stateStores.delete(stateKey);
      });
    }
    if (!binding) return loading; // Preserve legacy shared identity and behavior.
    if (!binding.loading) {
      binding.loading = loading.then((store) => {
        if (binding.retired) throw retiredError();
        return facadeFor(store, binding);
      });
      binding.loading.catch(() => { binding.loading = null; });
    }
    return binding.loading;
  };
  const stateForBotId = async (botId) => {
    const botConfig = listConfiguredBots().find((bot) => bot.id === botId);
    if (!botConfig) throw new Error('Unknown Feishu bot');
    return stateFor(botConfig);
  };
  // Session-sync mirror targets: which synced DMs (openId) belong to a
  // Session. Resolved lazily per turn start so rebinding a delivery target
  // takes effect without a restart. The resolver also reads the global delivery
  // switches, so the card mirror is silenced by the same predicate as the
  // coordinator's target path.
  const sessionSyncTargetsFor = createSessionSyncTargetsFor({
    channel: 'feishu',
    workspaces,
    config,
    stateForBotId,
  });
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
    botIdFrom: (bot) => bot?.id,
  });
  const { controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    controlExecutor: internals.controlExecutor,
    sessionMaintenanceExecutor: internals.sessionMaintenanceExecutor,
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    ungroupedWorkspace,
    // This plugin is already hosted by a running DSH process. Starting a
    // second DSH would create a competing server and lifecycle.
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
    imageInputPolicy: () => getImageInputSettingsStore(config).get(),
  });
  const proxyEnv = internals.proxyEnv ?? process.env;
  const wsAgent = createFeishuWebSocketAgent(proxyEnv, internals.createProxyAgent);

  const modelCatalog = (options) => listModelCatalog(harness, options);
  const coreController = new Controller({
    logger,
    registerApp: (options) => lark.registerApp(options),
    verifyApp,
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    createRuntime: async ({ botId, config: botConfig, appSecret, repair, acceptExternal }) => {
      // Runtime-local display partition, never read from profiles or callbacks.
      const hfcRuntimeNamespace = randomUUID();
      const state = await stateFor(botConfig);
      const id = botId ?? botConfig.id ?? botConfig.appId;
      await workspaces.ensure(id, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: newBotAccessPolicyFor('feishu', botConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        dsBot: config.deliveryService?.dsBot,
        botId: id, workspaces, state, agentPresetCatalog,
      });
      // 语音是可选渠道能力:凭据读取失败时静默禁用,不阻断机器人连接。
      let voiceSource = null;
      if (botConfig.voice) {
        try {
          const resolved = await ctx.credentials.resolve(botConfig.voice.secretRef);
          if (resolved?.value) voiceSource = { config: botConfig.voice, secret: resolved.value };
        } catch (error) {
          logger.warn?.('[dsh-feishu-voice] 语音凭据读取失败,语音已禁用:', error?.message ?? String(error));
        }
      }
      return new Runtime({
        lark,
        consumerMode: botConfig.consumerMode,
        acceptExternal,
        botId: id,
        repair,
        appId: botConfig.appId,
        appSecret,
        domain: botConfig.domain,
        botOpenId: botConfig.botOpenId,
        groupResponseMode: botConfig.groupResponseMode,
        mentionTopicReply: botConfig.mentionTopicReply,
        stepPush: botConfig.stepPush,
        stepPushMode: botConfig.stepPushMode,
        stepCardPanels: botConfig.stepCardPanels,
        hfcPresentation: botConfig.hfcPresentation,
        hfcRuntimeNamespace,
        hfcDiagnostic: createHfcDiagnosticRecorder(join(paths.bots, id, 'hfc-diagnostics.json')),
        voice: voiceSource,
        sessionSyncTargetsFor: sessionSyncTargetsFor,
        ownerOpenIds: botConfig.ownerOpenIds ?? [botConfig.ownerOpenId],
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        groupHistory: internals.groupHistory ?? getGroupHistoryStore(ctx, config),
        contextEnhancement: { botId: id, getSettings: () => workspaces.contextEnhancementFor(id) },
        accessPolicy: accessPolicyProvider(workspaces, id, {
          channel: 'feishu', config: botConfig,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        slashCommands: config.slashCommands !== false,
        slashPanel: botConfig.slashPanel,
        ...(wsAgent ? { wsAgent } : {}),
        logger: {
          error: (...args) => logger.error?.(`[${botId ?? botConfig.id}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId ?? botConfig.id}]`, ...args),
          info: (...args) => logger.info?.(`[${botId ?? botConfig.id}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId ?? botConfig.id}]`, ...args),
        },
      });
    },
    validateStateDeletion: ({ config: botConfig }) => validateStateDeletion(botConfig),
    beginStateDeletion: async ({ config: botConfig }) => {
      if (isV2(botConfig)) retire(botConfig.id);
      const stateKey = stateKeyFor(statePathFor(botConfig));
      // A surviving legacy owner retains the entire shared physical domain.
      if (!isV2(botConfig) && (!canListConfiguredBots || listConfiguredBots().some((other) =>
        other.id !== botConfig.id && stateKeyFor(statePathFor(other)) === stateKey))) return;
      // Acquire the physical core synchronously, even when this factory never
      // loaded it: another factory/raw handle may already own the same path.
      let fence = retirementHandles.get(stateKey);
      if (!fence) {
        fence = new StateStore(statePathFor(botConfig));
        retirementHandles.set(stateKey, fence);
      }
      await fence.beginRetirement();
    },
    deleteState: async ({ config: botConfig }) => {
      const statePath = resolve(statePathFor(botConfig));
      const stateKey = stateKeyFor(statePath);
      if (!isV2(botConfig) && (!canListConfiguredBots || listConfiguredBots().some((other) =>
        other.id !== botConfig.id && stateKeyFor(statePathFor(other)) === stateKey))) return;
      const loading = stateStores.get(stateKey);
      const store = loading ? await loading.catch(() => null) : null;
      const binding = bindings.get(botConfig.id);
      if (binding) await Promise.allSettled([...binding.pending]);
      const fence = retirementHandles.get(stateKey);
      if (fence) await fence.retire();
      else if (store?.retire) await store.retire();
      else await StateStore.retirePath(statePath);
    },
  });
  const workspaceController = createWorkspaceAwareController(coreController, {
    harness,
    workspaces,
    stateFor: stateForBotId,
    agentPresetCatalog,
    modelCatalog,
    validateAccessPolicyForBot(botId, policy) {
      const botOpenId = configStore.getBot(botId)?.botOpenId;
      if (!botOpenId) return;
      if ([policy.direct, policy.group].some((scope) => scope.mode === 'allowlist'
        && scope.allowlist.users.some((user) => user.id === botOpenId))) {
        const error = new TypeError(t('这里需要填写用户的 Open ID，不能填写机器人自己的 Open ID。'));
        error.code = 'access-policy-invalid';
        throw error;
      }
    },
  });

  const controller = new Proxy(workspaceController, {
    get(target, property) {
      if (property === 'deleteBot' || property === 'disconnect') return async (...args) => {
        // The generic workspace wrapper clears sessions before the controller's
        // preflight/pending commit, and would clear other legacy owners too.
        // Feishu removes workspaces through observedConfigStore only after its
        // config commit (also for internal cancellation and disconnect paths).
        await coreController[property](...args);
        return target.status();
      };
      return Reflect.get(target, property, target);
    },
  });

  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({ dsBot: config.deliveryService?.dsBot,
      channel: 'feishu', workspaces, coreController, stateFor: stateForBotId,
    }),
    ready: supervisor.ready,
    async close() {
      try {
        try { await supervisor.close(); }
        finally { await controller.close(); }
      } finally {
        await Promise.allSettled([...stateStores.values()].map(async (loading) => {
          const store = await loading.catch(() => null);
          await store?.close?.();
        }));
        stateStores.clear();
        await Promise.allSettled([...retirementHandles.values()].map((store) => store.close()));
        retirementHandles.clear();
        harness.stopManagedProcess();
        wsAgent?.destroy?.();
      }
    },
  };
}
