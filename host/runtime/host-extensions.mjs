import { createModelSession } from './model-session.mjs';
import { startLocalHostMcp } from './host-mcp.mjs';
import { decorateLocalHostAutomations } from './host-automations.mjs';
import { createHarnessModelErrorMapper } from './model-errors.mjs';
import { observeModelFetch } from './model-observation.mjs';
import { startLocalNotifications } from './host-notifications.mjs';
import { startLocalAutoReview } from './host-auto-review.mjs';
import { localTemplates } from './host-local-profile.mjs';
import { createModelRouter } from './model-router.mjs';
import { recordUsage } from './usage-ledger.mjs';
import { transcribeLocalAudio } from './host-speech.mjs';
import { createLocalCapabilities, startLocalMemory } from './host-capabilities.mjs';
import { contextPolicyFor } from './context-policy.mjs';
import { startLocalManagedSkills } from './host-skills.mjs';
import { startLocalWebhooks } from './host-webhooks.mjs';
import { startLocalFederation } from './host-federation.mjs';
import { createLocalServiceRuntime } from './media-runtime.mjs';

const unsubscribe = () => () => {};
export function unavailable(capability) {
  const error = new Error(`${capability} is unavailable in the local workspace runtime`);
  error.code = 'LOCAL_CAPABILITY_UNAVAILABLE';
  return error;
}
const rejectCapability = capability => async () => { throw unavailable(capability); };

function localAuth() {
  return {
    getAccessToken: rejectCapability('Official account authentication'),
    getBestEffortAccessToken: async () => null,
    peekAccessToken: () => null,
    getTeamId: async () => undefined,
    getMachineId: async () => 'local-workspace',
    getLastRenewalEvent: () => null,
    subscribeToRenewal: unsubscribe,
    getUserFullName: () => undefined,
  };
}

function localIdentity() {
  return {
    isWriteEnabled: async () => false,
    ensureServerBacked: rejectCapability('Server agent identity'),
    createRemoteAgentFirst: rejectCapability('Server agent creation'),
    createAgentFromTemplate: rejectCapability('Published bot templates'),
    rollbackRemoteAgent: rejectCapability('Server agent rollback'),
    noteAgentImported() {}, noteAgentMinted() {}, async noteAgentDeleted() {},
    async reconcileNow() {},
  };
}

function inference(config, library, services) {
  return {
    isReady: async () => true,
    port: {
      resolvePrivacyMode: async () => library.PrivacyMode.NO_STORAGE,
      getGeminiVideoAttachedMediaUrlProvider: () => undefined,
      videoAnalysisEnabled: services.videoAnalysisEnabled,
      createSession: (onRequestId, options) => ['watchVideo', 'videoReview'].includes(options?.localMediaKind) && services.videoAnalysisEnabled(options.localMediaKind)
        ? services.createVideoSession(options.localMediaKind, onRequestId)
        : createModelSession({ ...config, ...contextPolicyFor(config, config.model), onRequestId,
        selectRequest: createModelRouter(options?.isSummarizationSession && config.policy ? { ...config, policy: { ...config.policy, mode: 'manual' } } : config, { onDecision: decision => console.info('[model-router]', JSON.stringify(decision)) }),
        onUsage: usage => recordUsage(config.usageDirectory, { ...usage, kind: options?.isSummarizationSession ? 'summary' : 'chat' }),
        fetchImpl: observeModelFetch(globalThis.fetch, options),
        mapError: createHarnessModelErrorMapper(library) }),
      // These are official analytics endpoints, disabled with Host telemetry.
      recordPostTurnLabeling() {}, recordFollowupLabeling() {},
    },
    onModelExperimentApplied: unsubscribe,
    createWebSearch: services.createWebSearch,
    createWebFetch: services.createWebFetch,
    transcribeAudio: transcribeLocalAudio,
  };
}

/** Keep original stateful extensions; substitute account and inference boundaries. */
export function createExtensionStarter(library, modelConfig) {
  let capabilities, services;
  const apis = new Map();
  const replacements = {
    auth: () => localAuth(),
    'agent-identity': () => localIdentity(),
    'managed-setup': startLocalManagedSkills,
    'bot-template-share': () => localTemplates(),
    'remote-agent-messaging': context => startLocalFederation(context, { extensions: id => apis.get(id) }),
    inference: () => inference(modelConfig, library, services),
    mcp: context => startLocalHostMcp(context, library, { nativeEnabled: () => capabilities.get().macComputer,
      permission: () => apis.get('local-tool-permission') }),
    'auto-review': context => startLocalAutoReview(context, library, modelConfig),
    ...(process.env.GROKBOT_NOTIFICATION_URL
      ? { notifications: context => startLocalNotifications(context, library) } : {}),
  };
  return async ({ host }) => {
    capabilities = await createLocalCapabilities(process.env.GROKBOT_DATA_DIR ?? process.env.GROKBOT_STATE_DIR ?? '/research/state');
    services = await createLocalServiceRuntime(process.env.GROKBOT_DATA_DIR ?? process.env.GROKBOT_STATE_DIR ?? '/research/state');
    const startExtension = async (extension, context) => {
      host.log(`starting extension ${extension.id}`);
      if (extension.id === 'memory') return startLocalMemory(context, extension, capabilities);
      const api = await (replacements[extension.id] ? replacements[extension.id](context) : extension.start(context));
      if (extension.id === 'attachments') return services.decorateAttachments(api);
      if (extension.id === 'experiments') {
        context.onStop(() => capabilities.close());
        return capabilities.experiments(api);
      }
      if (extension.id !== 'automations') return api;
      const automations = await decorateLocalHostAutomations(context, library, api);
      const webhooks = await startLocalWebhooks(context);
      return { ...automations,
        async suspendWakes() { webhooks.suspend(); apis.get('remote-agent-messaging')?.suspend?.(); return automations.suspendWakes(); },
        resumeWakes() { const result = automations.resumeWakes(); webhooks.resume(); apis.get('remote-agent-messaging')?.resume?.(); return result; },
      };
    };
    const extensions = library.hostExtensionRegistry.map(extension => ({
      ...extension,
      start: async context => {
        const api = await startExtension(extension, context); apis.set(extension.id, api); return api;
      },
    }));
    const started = await library.startHostExtensions({
      extensions, host,
      onStopFailure: (id, error) => host.log(`extension ${id} stop failed: ${error.message}`),
    });
    return { order: started.order, api: id => started.apis[id], stop: started.stop };
  };
}
