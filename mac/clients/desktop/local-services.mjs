import { grokText } from './i18n.mjs';
import { createConnectorHandlers } from './connectors.mjs';
import { externalHttpUrl } from './external-url.mjs';
import { createLinkPreview } from './link-preview.mjs';
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export const auth = {
  kind: "logged-in",
  authId: "grokbot-local-workspace",
  email: "",
  displayName: "本地工作区",
  profileReady: true,
  isAnysphereUser: false,
  freshness: 0,
};
export const theme = {
  preference: "dark",
  resolved: "dark",
  systemAccentColor: null,
};
export const language = { preference: "en", resolved: "en" };
export const experiments = {
  featureGates: {
    sand_create_temporal_agents: false,
    grok_bot_box_harness_turns_blocked: false,
    sand_profile_photo_edit: true,
    sand_teach_by_demonstration: true,
    publish_user_skills: true,
    agent_prompted_cookie_sync: true,
    sand_voice_call: false,
    sand_voice_resumption: false,
  },
  dynamicConfigs: {},
};
export const boot = {
  mainEdge: "served",
  theme,
  language,
  experiments,
  isAssistiveTechEnabled: false,
  isEgressTunnelEnabled: false,
  isWebauthnProxyEnabled: true,
  isBotColorInChatEnabled: false,
  egressTunnelStatus: { enabled: false, active: false },
  rosterPhotos: null,
  computerUseHelperName: "Grok Bot Computer Use",
};
const access = {
  state: "granted",
  reason: "none",
  privacyDisclaimerRequired: false,
  purchasableTiers: [],
  proAndSuperGrokPlansGrantAccess: false,
  isUnified: false,
};
export async function createLocalServices(profile, window, { command, request, attachment, attachmentHandlers = {}, connection, disconnect, notifications, pickAvatarFile, openExternal, settings = {} }) {
  const storePath = path.join(profile, "local-client-persistence.json");
  let store = {};
  try {
    store = JSON.parse(await readFile(storePath, "utf8"));
  } catch {}
  const persist = () => writeFile(storePath, JSON.stringify(store), "utf8");
  const linkPreview = createLinkPreview({ profile });
  const known = {
    getLinkMetadata: args => linkPreview.getMetadata(args),
    resolveAttachmentMedia: attachment,
    ...attachmentHandlers,
    transcribeAudio: ({ audio, mimeType, language }) => request('/local/audio/transcriptions', {
      audioBase64: Buffer.from(audio).toString('base64'), mimeType,
      ...(language ? { language } : {}),
    }, AbortSignal.timeout(120000)),
    openSelfHostedConnection: connection,
    loginCursor: connection,
    logoutCursor: disconnect,
    addCursorAccount: connection,
    pickAvatarFile,
    listGrokBotAgentFiles: ({ agentId }) => request(`/local/files?agentId=${encodeURIComponent(agentId)}`, null, AbortSignal.timeout(15000), 'GET'),
    uploadGrokBotAgentFile: ({ agentId, fileName, contentType, bytes }) => request('/local/files',
      { agentId, fileName, contentType, base64: Buffer.from(bytes).toString('base64') }, AbortSignal.timeout(60000)),
    deleteGrokBotAgentFile: async ({ agentId, name }) => { await request('/local/files', { agentId, name }, AbortSignal.timeout(15000), 'DELETE'); },
    getAutoReviewInstructions: async () => (await command('getHostSettings')).autoReviewInstructions ?? { isEnabled: false, allowInstructions: [], blockInstructions: [] },
    setAutoReviewInstructions: async ({ instructions }) => {
      await command('setHostSettings', { autoReviewInstructions: instructions });
      return (await command('getHostSettings')).autoReviewInstructions;
    },
    getDesktopNotificationPreferences: () => notifications.getPreferences(),
    setDesktopNotificationPreferences: ({ preferences }) => notifications.setPreferences(preferences),
    setComposingAgent: () => null,
    clearLocalToolApprovals: () => null,
    peekUsageWarningAssignment: () => null,
    getCursorWeeklyUsage: () => null,
    reportClientFailure: () => null,
    getTimeZone: () => ({
      detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      overrideTimeZone: null,
    }),
    signalBoxIntent: () => null,
    setComputerViewOpen: () => null,
    getOnboardingSeen: () => true,
    setOnboardingSeen: () => null,
    markDeepLinksReady: () => null,
    setViewingAgent: ({ agentId }) => notifications.noteViewingAgent(agentId),
    getCursorPrReviewPreferences: () => ({}),
    getCursorUsageSummary: () => null,
    getBoxMigrationStatus: () => null,
    getBoxHostPhase: () => "settled",
    getTeamMemberPolicy: () => null,
    // null lets the original migration read Host pins; [] would mean a cloud-side clear.
    getServerPinnedAgents: () => null,
    // These are desktop IPC methods; the Host persists both in its settings RPC.
    getHostPinnedAgents: async () => (await command('getHostSettings')).pinnedAgentIds ?? null,
    setHostPinnedAgents: async ({ pinnedAgentIds }) =>
      (await command('setHostSettings', { pinnedAgentIds })).pinnedAgentIds ?? null,
    getHostSidebarSections: async () => (await command('getHostSettings')).sidebarSections ?? null,
    setHostSidebarSections: async ({ sections }) =>
      (await command('setHostSettings', { sidebarSections: sections })).sidebarSections ?? null,

    getCursorAuthStatus: () => auth,
    getCursorLoginFlight: () => ({ kind: "idle" }),
    listCursorAccounts: () => ({
      accounts: [auth],
      activeAccountId: auth.authId,
      corrupt: false,
    }),
    getCursorSelectedTeam: () => ({ selectedTeamId: null, fallback: null }),
    listCursorTeamMemberships: () => [],
    getCursorAvatar: () => null,
    getSandAccess: () => access,
    getSandAccessFresh: () => access,
    getGrokBotTermsRecord: () => ({ seenAtMs: Date.now(), version: 1 }),
    getThemeState: () => theme,
    getLanguageState: () => language,
    getExperimentsSnapshot: () => experiments,
    getWindowState: () => ({
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
      isFocused: window.isFocused(),
    }),
    minimizeWindow: () => window.minimize(),
    focusWindow: () => window.focus(),
    closeWindow: () => window.close(),
    toggleMaximizeWindow: () =>
      window.isMaximized() ? window.unmaximize() : window.maximize(),
    readClientPersistence: ({ key }) => store[key] ?? null,
    readManyClientPersistence: ({ include, exclude = [] }) =>
      Object.fromEntries(Object.entries(store).filter(([key]) => {
        const longest = prefixes => prefixes.reduce((length, prefix) =>
          key.startsWith(prefix) ? Math.max(length, prefix.length) : length, -1);
        const included = longest(include);
        return included >= 0 && included >= longest(exclude);
      })),
    writeClientPersistence: async ({ key, value }) => {
      store[key] = value;
      await persist();
    },
    removeClientPersistence: async ({ key }) => {
      delete store[key];
      await persist();
    },
    listClientPersistenceKeys: ({ prefix }) =>
      Object.keys(store).filter((x) => x.startsWith(prefix)),
    hasMigratedClientPersistence: () => true,
    migrateClientPersistence: async ({ entries }) => {
      for (const e of entries) store[e.key] = e.value;
      await persist();
    },
    getEgressTunnelEnabled: () => false,
    getWebauthnProxyEnabled: () => true,
    getBotColorInChatEnabled: () => false,
    getEgressTunnelStatus: () => boot.egressTunnelStatus,
    getNotificationPreferences: () => notifications.getPreferences(),
    getHardwareAcceleration: () => true,
    getUpdateStatus: () => ({
      state: { type: "disabled", reason: "disabled-by-env" },
      currentVersion: "0.71.2",
      currentTrack: "stable",
      availableTracks: ["stable"],
      isTrackManagedByPolicy: true,
      delivery: "package-manager",
      isBelowMinimumVersion: false,
      autoUpdateWhenIdle: false,
    }),
    getCredentialsState: () => ({
      connections: [],
      credentials: [],
      catalogRevision: "local",
    }),
    ...createConnectorHandlers({ command, openExternal }),
    getCursorPrivacyModeEnabled: () => false,
    getCursorUnifyCta: () => null,
    getCurrentMachineMessagesEnabled: () => false,
    listSecrets: () => [],
    listMeetings: () => [],
    listMessagesAllowedRecipients: () => [],
    listComputerUseAllowedApps: () => [],
    attachProdBoxStatus: () => ({ enabled: false }),
    getSandMachines: () => ({ machines: [], currentMachineRemoved: false }),
    getFinanceOverview: () => ({ connections: [] }),
    forceReconnectGateway: async () => { await command("listAgents"); return { connected: true }; },
    openExternal: async ({ url }) => {
      if (url?.startsWith('grokbot-local:')) return null;
      const target = externalHttpUrl(url);
      if (!target) throw new Error(grokText('链接地址无效。', 'Invalid link address.'));
      await openExternal(target);
      return null;
    },
    getHostSettings: () => command("getHostSettings"),
    setHostSettings: (args) => command("setHostSettings", args),
  };
  Object.assign(known, settings);
  return async (method, args = {}) => {
    if (known[method]) return known[method](args);
    if (
      /^(report|note|expose|log|setTitleBar|setUnreadFilter|setWindow|markGrokBotTerms)/.test(
        method,
      )
    )
      return null;
    console.error("[missing local method]", method);
    throw new Error(`Local desktop does not implement ${method}`);
  };
}
