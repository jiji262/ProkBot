require('../dist/electron-preload/preload.cjs');
const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('localBot', {
  locale: ipcRenderer.sendSync('grokbot-local:locale'),
  openManagement: () => ipcRenderer.send('grokbot-local:open-management'),
  updateProfile: (id, profile) => ipcRenderer.invoke('grokbot-local:update-profile', { id, profile }),
  connectionStatus: () => ipcRenderer.invoke('grokbot-local:status'),
  mintVoiceCredential: agentId => ipcRenderer.invoke('grokbot-local:voice-credential', agentId),
  getVoicePreference: () => ipcRenderer.invoke('grokbot-local:voice-preference'),
  setVoicePreference: enabled => ipcRenderer.invoke('grokbot-local:voice-preference', enabled),
  onVoicePreferenceChanged: callback => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('grokbot-local:voice-preference', listener);
    return () => ipcRenderer.removeListener('grokbot-local:voice-preference', listener);
  },
  pair: args => ipcRenderer.invoke('grokbot-local:pair', args),
  disconnect: () => ipcRenderer.invoke('grokbot-local:disconnect'),
  onConnectionChanged: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('grokbot-local:connection-changed', listener);
    return () => ipcRenderer.removeListener('grokbot-local:connection-changed', listener);
  },
});
