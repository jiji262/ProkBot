import { grokText } from './i18n.mjs';
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const defaults = { theme: 'dark', language: 'system', spellCheck: true, hardwareAcceleration: true, botColor: false, timeZone: null, realtimeVoice: false };
export function loadSettings(profile) {
  try { return { ...defaults, ...JSON.parse(readFileSync(path.join(profile, 'settings.json'), 'utf8')) }; }
  catch { return { ...defaults }; }
}
export function createSettings({ profile, window, app, nativeTheme, settings, enabledAtLaunch, command, theme, language, boot, onVoicePreference }) {
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(settings);
    writes = writes.catch(() => {}).then(async () => {
      const filename = path.join(profile, 'settings.json');
      await writeFile(`${filename}.tmp`, snapshot, { mode: 0o600 }); await rename(`${filename}.tmp`, filename);
    });
    return writes;
  };
  const emit = (event, value) => { if (!window.isDestroyed()) window.webContents.send(`dune-rpc:main:e:${event}`, value); };
  const resolveLanguage = locale => {
    if (/^zh-(TW|HK|MO|Hant)/i.test(locale)) return 'zh-TW';
    if (/^zh/i.test(locale)) return 'zh-CN';
    return locale.split('-')[0] || 'en';
  };
  const updateTheme = () => {
    Object.assign(theme, { preference: settings.theme, resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', systemAccentColor: null });
    if (!window.isDestroyed()) window.setBackgroundColor(theme.resolved === 'dark' ? '#111111' : '#ffffff');
    emit('theme-changed', theme); return { ...theme };
  };
  const updateLanguage = () => {
    Object.assign(language, { preference: settings.language, systemLanguage: app.getLocale(), resolved: settings.language === 'system' ? resolveLanguage(app.getLocale()) : settings.language });
    emit('language-changed', language); return { ...language };
  };
  const hardware = () => ({ enabled: settings.hardwareAcceleration, enabledAtLaunch,
    pdfRasterMode: app.getGPUFeatureStatus().rasterization?.startsWith('enabled') ? 'gpu' : 'software' });
  const timeZone = () => ({ detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, overrideTimeZone: settings.timeZone });
  nativeTheme.themeSource = settings.theme; updateTheme(); updateLanguage();
  nativeTheme.on('updated', updateTheme); window.once('closed', () => nativeTheme.removeListener('updated', updateTheme));
  window.webContents.session.setSpellCheckerEnabled(settings.spellCheck);
  boot.isBotColorInChatEnabled = settings.botColor;
  return {
    getRealtimeVoiceEnabled: () => settings.realtimeVoice === true,
    setRealtimeVoiceEnabled: async ({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid voice preference');
      settings.realtimeVoice = enabled; await persist();
      if (!window.isDestroyed()) window.webContents.send('grokbot-local:voice-preference', enabled);
      await onVoicePreference?.();
      return enabled;
    },
    getThemeState: () => ({ ...theme }),
    setThemePreference: async ({ preference }) => {
      if (!['dark', 'light', 'system'].includes(preference)) throw new Error('Invalid theme');
      settings.theme = preference; await persist(); nativeTheme.themeSource = preference; return updateTheme();
    },
    getLanguageState: () => ({ ...language }),
    setLanguagePreference: async ({ preference }) => {
      settings.language = preference; await persist(); return updateLanguage();
    },
    getSpellCheckEnabled: () => settings.spellCheck,
    setSpellCheckEnabled: async ({ enabled }) => { settings.spellCheck = Boolean(enabled); await persist(); window.webContents.session.setSpellCheckerEnabled(settings.spellCheck); return settings.spellCheck; },
    getBotColorInChatEnabled: () => settings.botColor,
    setBotColorInChatEnabled: async ({ enabled }) => { settings.botColor = Boolean(enabled); boot.isBotColorInChatEnabled = settings.botColor; await persist(); return settings.botColor; },
    getHardwareAcceleration: hardware,
    setHardwareAccelerationEnabled: async ({ enabled }) => { settings.hardwareAcceleration = Boolean(enabled); await persist(); return hardware(); },
    relaunchDesktop: () => { app.relaunch(); app.quit(); },
    getTimeZone: timeZone,
    setTimeZoneOverride: async ({ timeZone: value }) => {
      if (value !== null) new Intl.DateTimeFormat('en', { timeZone: value }).format();
      await command('setHostSettings', { userTimeZone: timeZone().detectedTimeZone, userTimeZoneOverride: value ?? '' });
      settings.timeZone = value; await persist(); return timeZone();
    },
    getMessagesAppIcon: () => null,
    updateCurrentMachineMessagesEnabled: () => { throw new Error(grokText('信息服务不可用。', 'Messages service unavailable.')); },
  };
}
