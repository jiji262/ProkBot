import { app, BrowserWindow, clipboard, dialog, ipcMain, MessageChannelMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, session, shell } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokText as localText, setLocaleSource } from './i18n.mjs';
import { credentialStore, pair, openTransport } from './connection.mjs';
import { createGateway } from './gateway.mjs';
import { createAttachmentHandlers, createAttachmentMediaResolver } from './attachments.mjs';
import { createAttachmentUploads } from './attachment-uploads.mjs';
import { createNotifications, agentFromLink } from './notifications.mjs';
import { loadSettings, createSettings } from './settings.mjs';
import { createProfile } from './profile.mjs';
import { createLocalExec } from './local-exec.mjs';
import { createBrowserProviders } from './browser-providers.mjs';
import { createSounds } from './sounds.mjs';
import { mintVoiceCredential, createVoiceAvailability } from './voice.mjs';
import { externalHttpUrl } from './external-url.mjs';
import { installExternalLinks } from './external-links.mjs';
import { auth, boot, theme, language, experiments, createLocalServices } from './local-services.mjs';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const payload = path.join(clientRoot, '../dist');
const profile = process.env.GROKBOT_LOCAL_DEBUG_PORT && process.env.GROKBOT_LOCAL_TEST_PROFILE
  ? path.resolve(process.env.GROKBOT_LOCAL_TEST_PROFILE)
  : path.join(app.getPath('appData'), 'Grok Bot Local');
app.setPath('userData', profile);
app.setName('Grok Bot Local');
const clientSettings = loadSettings(profile);
const enabledAtLaunch = clientSettings.hardwareAcceleration;
if (!enabledAtLaunch) app.disableHardwareAcceleration();
process.env.SAND_DISABLE_UPDATES = '1';
process.env.SAND_DISABLE_TELEMETRY = '1';
app.commandLine.appendSwitch('disable-breakpad');
// Debugging is opt-in and loopback only; packaged clients expose no debug port.
if (process.env.GROKBOT_LOCAL_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', process.env.GROKBOT_LOCAL_DEBUG_PORT);
}
let config, mainWindow, connectWindow, gateway, notifications, connectionError = '';
let quitting = false, starting = true;
let transport;
const transportBinary = path.join(process.resourcesPath, 'grokbot-tailcat');
let methodCall, accountProfile, localExec, browserProviders, voiceAvailability, deepLinksReady = false, pendingAgent = null;
const ports = new Set();
const store = credentialStore(profile, safeStorage);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_event, argv) => {
  const link = argv.find(value => value.startsWith('grokbot-local:'));
  if (link) routeLink(link);
  (mainWindow ?? connectWindow)?.show();
});
app.on('open-url', (event, url) => { event.preventDefault(); routeLink(url); });
// Re-pairing replaces the workspace window. Keep the macOS process alive during
// that transition, just as closing the regular window keeps the client running.
app.on('window-all-closed', () => {});
function routeLink(url) { const id = agentFromLink(url); if (id) openAgent(id); }
function openAgent(id) {
  pendingAgent = id;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (config && app.isReady()) void showWorkspace();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  if (deepLinksReady) {
    mainWindow.webContents.send('dune-rpc:main:e:focus-agent', { id });
    pendingAgent = null;
  }
}
function trusted(event, window) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}
function requireConnection(event) {
  if (!trusted(event, connectWindow) && !trusted(event, mainWindow)) throw new Error('Unexpected renderer');
}
function stopConnection() {
  voiceAvailability?.close(); voiceAvailability = null;
  browserProviders?.close(); browserProviders = null;
  localExec?.close(); localExec = null;
  for (const dispose of ports) dispose(); ports.clear();
  notifications?.stop(); notifications = null;
  gateway?.close();
}
function disposeWorkspace() {
  stopConnection();
  deepLinksReady = false; methodCall = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
}
function connectionStatus() {
  return { paired: Boolean(config), connected: Boolean(config), server: config?.address ?? config?.server,
    tailcat: config?.tailcat === true, transportPath: transport?.tunnel?.status.path ?? 'direct',
    state: config ? gateway?.getState() ?? 'connecting' : 'disconnected',
    profile: config ? accountProfile?.current() ?? null : null, error: connectionError };
}
function reportConnection() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('grokbot-local:connection-changed', connectionStatus());
}
function unauthorized() {
  connectionError = localText('连接已失效，请重新配对。', 'Connection expired. Pair again.');
  void showConnection();
}
async function openExternal(value) {
  const target = externalHttpUrl(value);
  if (!target) throw new Error(localText('链接地址无效。', 'Invalid link address.'));
  await shell.openExternal(target);
}
async function showConnection() {
  if (!app.isReady()) return;
  if (connectWindow && !connectWindow.isDestroyed()) { connectWindow.show(); connectWindow.focus(); return; }
  connectWindow = new BrowserWindow({ width: 510, height: 510, resizable: false,
    title: localText('连接 Grok Bot', 'Connect Grok Bot'), backgroundColor: '#111111', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: { preload: path.join(clientRoot, 'connect-preload.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  connectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWindow.webContents.on('will-navigate', event => event.preventDefault());
  connectWindow.on('closed', () => { connectWindow = null; });
  await connectWindow.loadFile(path.join(clientRoot, 'connect.html'));
}
function updateMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Grok Bot', submenu: [{ role: 'about' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}
async function showWorkspace() {
  disposeWorkspace();
  const activeConfig = config;
  const reportFocus = () => {
    void gateway.command('setWindowFocused', { isFocused: Boolean(mainWindow?.isFocused()) }).catch(() => {});
    if (mainWindow?.isFocused()) void accountProfile?.refresh().catch(() => {});
  };
  gateway = createGateway(activeConfig, unauthorized, reportFocus, reportConnection);
  const win = new BrowserWindow({ width: 1200, height: 850, minWidth: 720, minHeight: 500,
    title: 'Grok Bot', backgroundColor: '#111111', frame: true, titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: { preload: path.join(clientRoot, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: false, webviewTag: true } });
  mainWindow = win;
  voiceAvailability = createVoiceAvailability({ request: gateway.request, window: win, experiments, getPreference: () => clientSettings.realtimeVoice });
  void voiceAvailability.refresh();
  accountProfile = createProfile({ request: gateway.request, window: win, auth, server: activeConfig.server, onChange: reportConnection });
  await accountProfile.refresh().catch(() => {});
  localExec = await createLocalExec({ payload, profile, config: activeConfig, command: gateway.command, window: win });
  browserProviders = await createBrowserProviders({ payload, profile, config: activeConfig, window: win,
    BrowserWindow, locale: () => language.resolved });
  win.on('focus', reportFocus); win.on('blur', reportFocus);
  win.on('close', event => {
    if (!quitting) { event.preventDefault(); win.hide(); }
    if (process.env.GROKBOT_LOCAL_DEBUG_PORT) console.log('[notification-window]', JSON.stringify({visible:win.isVisible(),focused:win.isFocused(),quitting}));
    void gateway.command('setWindowFocused', { isFocused: false }).catch(() => {});
  });
  notifications = await createNotifications({ config: activeConfig, profile, Notification, openAgent,
    sounds: await createSounds(profile, payload), command: gateway.command, getWindow: () => BrowserWindow.getFocusedWindow() ?? mainWindow,
    reportDecision: item => { if (process.env.GROKBOT_LOCAL_DEBUG_PORT) console.log('[notification-decision]', JSON.stringify(item)); },
    onUnauthorized: unauthorized });
  const uploads = createAttachmentUploads({ profile, command: gateway.command,
    onProgress: progress => { if (!win.isDestroyed()) win.webContents.send('dune-rpc:main:e:attachment-commit-progress', progress); } });
  methodCall = await createLocalServices(profile, win, {
    command: gateway.command, request: gateway.request, connection: showConnection, openExternal,
    attachmentHandlers: { ...uploads.handlers, ...createAttachmentHandlers({
      command: gateway.command,
      readStaged: uploads.readStaged,
      chooseDestination: async name => {
        const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
        return result.canceled ? null : result.filePath;
      },
      showDownloadError: () => dialog.showMessageBox(win, { type: 'error',
        message: localText('无法下载文件，请重试。', 'Could not download this file. Try again.') }),
    }) },
    disconnect: async () => { await store.clear(); config = null; disposeWorkspace(); await transport?.close(); transport = null; await showConnection(); }, notifications,
    settings: { ...createSettings({ profile, window: win, app, nativeTheme, settings: clientSettings, enabledAtLaunch, command: gateway.command, theme, language, boot, onVoicePreference: () => voiceAvailability.refresh() }), ...accountProfile.handlers, ...localExec.handlers, ...browserProviders.handlers,
      getExperimentsSnapshot: () => voiceAvailability.refresh() },
    pickAvatarFile: async () => {
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: localText('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      const bytes = await readFile(result.filePaths[0]);
      if (bytes.length > 20 * 1024 * 1024) throw new Error(localText('图片不能超过 20 MB。', 'Image must be smaller than 20 MB.'));
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error(localText('无法读取图片。', 'Could not read this image.'));
      return { dataUrl: image.toDataURL(), fileName: path.basename(result.filePaths[0]) };
    },
    attachment: createAttachmentMediaResolver({ command: gateway.command, readStaged: uploads.readStaged, nativeImage }),
  });
  installExternalLinks(win, { openExternal, clipboard, Menu, text: localText });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    try {
      const url = new URL(params.src);
      if (url.origin !== activeConfig.server || !['http:', 'https:'].includes(url.protocol)) { event.preventDefault(); return; }
      preferences.sandbox = true; preferences.nodeIntegration = false; preferences.contextIsolation = true;
      preferences.preload = path.join(clientRoot, 'preload-vnc.cjs');
    } catch { event.preventDefault(); }
  });
  win.on('closed', () => {
    localExec?.close(); localExec = null;
    for (const dispose of ports) dispose(); ports.clear();
    deepLinksReady = false;
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on('preload-error', (_event, _file, error) => console.error('[preload]', error.message));
  win.webContents.on('render-process-gone', (_event, details) => console.error('[renderer]', details.reason));
  await win.loadFile(path.join(payload, 'renderer/index.html'));
  updateMenu();
  connectWindow?.close();
}

ipcMain.on('grokbot-local:locale', event => { event.returnValue = trusted(event, mainWindow) || trusted(event, connectWindow) ? (clientSettings.language === 'system' ? app.getLocale() : clientSettings.language) : 'en'; });
ipcMain.on('sand:boot-snapshot-sync', event => { event.returnValue = trusted(event, mainWindow) ? boot : {}; });
ipcMain.handle('grokbot-local:status', async event => {
  requireConnection(event);
  if (config && accountProfile) await accountProfile.refresh().catch(() => {});
  return connectionStatus();
});
ipcMain.handle('grokbot-local:voice-credential', async (event, agentId) => {
  if (!trusted(event, mainWindow) || !config || !gateway) throw new Error('Unexpected renderer');
  try {
    if (clientSettings.realtimeVoice !== true) throw new Error(localText('请启用实时语音。', 'Enable realtime voice.'));
    return { ok: true, credential: await mintVoiceCredential({ request: gateway.request, server: config.server }, agentId) };
  }
  catch (error) { return { ok: false, fault: 'unavailable', detail: error.message }; }
});
ipcMain.handle('grokbot-local:voice-preference', async (event, enabled) => {
  if (!trusted(event, mainWindow) || !methodCall) throw new Error('Unexpected renderer');
  return enabled === undefined ? methodCall('getRealtimeVoiceEnabled') : methodCall('setRealtimeVoiceEnabled', { enabled });
});
ipcMain.handle('grokbot-local:pair', async (event, args) => {
  requireConnection(event);
  try {
    // Check the keychain before consuming a one-use pairing Key.
    if (!safeStorage.isEncryptionAvailable()) throw new Error(localText('请解锁 macOS 钥匙串。', 'Unlock your macOS keychain.'));
    const nextTransport = await openTransport(args.server, args.tailcat === true, { binary: transportBinary });
    let next;
    try {
      if (args.edit === true) {
        if (!config) throw new Error('Not connected');
        const response = await fetch(`${nextTransport.server}/connect/status`, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(35000), redirect: 'error' });
        if (!response.ok) throw new Error(localText('无法验证此 Host 的设备凭据。', 'Could not verify this device with the Host.'));
        await response.body?.cancel(); next = { ...config, ...nextTransport };
      } else next = { ...await pair(nextTransport.server, args.key, fetch, { tunneled: nextTransport.tailcat }), ...nextTransport };
      await store.save(next);
    } catch (error) { await nextTransport.close(); throw error; }
    disposeWorkspace(); await transport?.close(); transport = nextTransport; config = next; connectionError = '';
    setTimeout(() => { void showWorkspace(); }, 200);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('grokbot-local:disconnect', async event => {
  requireConnection(event); await store.clear(); config = null; connectionError = '';
  stopConnection(); await transport?.close(); transport = null; reportConnection(); updateMenu();
  return { ok: true };
});
ipcMain.on('grokbot-local:open-management', event => { if (trusted(event, mainWindow) && config) void shell.openExternal(`${config.server}/admin`); });
ipcMain.handle('grokbot-local:update-profile', async (event, args) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  if (typeof args?.id !== 'string' || !args.profile || Object.entries(args.profile).some(([key, value]) => !['title', 'description'].includes(key) || typeof value !== 'string')) throw new Error('Invalid Bot profile');
  const agents = await gateway.command('listAgents');
  const current = agents.find(agent => agent.id === args.id);
  if (!current) throw new Error(localText('Bot 不存在', 'Bot not found'));
  return gateway.command('updateAgent', { id: args.id, profile: {
    name: current.name, title: current.title ?? '', description: current.description ?? '',
    ...args.profile,
  } });
});
ipcMain.handle('sand:coordinator-port-request', event => {
  if (!trusted(event, mainWindow) || !gateway || !config) return;
  const { port1, port2 } = new MessageChannelMain();
  const dispose = gateway.attach(port1); ports.add(dispose);
  port1.on('close', () => ports.delete(dispose));
  event.sender.postMessage('sand:coordinator-port', null, [port2]);
});

app.whenReady().then(async () => {
setLocaleSource(() => clientSettings.language === 'system' ? app.getLocale() : clientSettings.language);
await mkdir(profile, { recursive: true, mode: 0o700 });
app.setAsDefaultProtocolClient('grokbot-local');
// Official update and account network code is never started. Renderer traffic
// is restricted to the current Host; credentials stay in this main process.
const restrict = target => target.webRequest.onBeforeRequest((details, callback) => {
  try {
    const url = new URL(details.url);
    const isAsset = ['file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol);
    const hostOrigin = ['ws:', 'wss:'].includes(url.protocol) ? url.origin.replace(/^ws/, 'http') : url.origin;
    callback({ cancel: !(isAsset || (config && hostOrigin === config.server)) });
  } catch { callback({ cancel: true }); }
});
restrict(session.defaultSession); app.on('session-created', restrict);
const preload = await readFile(path.join(payload, 'electron-preload/preload.cjs'), 'utf8');
const names = new Set([...preload.matchAll(/([A-Za-z_$][\w$]*):t\(\)\.(?:args|noArgs)/g)].map(match => match[1]));
for (const method of names) ipcMain.handle(`dune-rpc:main:m:${method}`, async (event, args) => {
  if (!trusted(event, mainWindow)) return { ok: false, failure: { code: 'edge/untrusted', detail: 'Unexpected renderer' } };
  try {
    if (method === 'markDeepLinksReady') {
      deepLinksReady = true;
      if (pendingAgent) setTimeout(() => openAgent(pendingAgent), 0);
      return { ok: true, value: null };
    }
    return { ok: true, value: await methodCall(method, args) };
  } catch (error) { return { ok: false, failure: { code: 'edge/handler-failed', detail: error.message } }; }
});
ipcMain.handle('dune-rpc:main:probe', (event, method) => ({ ok: trusted(event, mainWindow), value: names.has(method) }));
updateMenu();
app.on('activate', () => {
  if (starting) return;
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else if (!connectWindow) void (config ? showWorkspace() : showConnection());
});
app.on('before-quit', () => { quitting = true; stopConnection(); void transport?.close(); });
// Activate the app for any Keychain prompt, then choose the first window from
// the saved credentials. Dock activation must not open pairing during loading.
app.focus();
try { config = await store.load(); if (config) { transport = await openTransport(config.address ?? config.server, config.tailcat, { identity: config.networkIdentity, binary: transportBinary }); config = { ...config, ...transport }; } }
catch { connectionError = localText('无法读取设备凭证，请重新配对。', 'Could not read device credentials. Pair again.'); }
if (config) await showWorkspace();
else await showConnection();
starting = false;
}).catch(error => { console.error('[startup]', error); app.quit(); });
