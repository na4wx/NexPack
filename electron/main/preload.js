const { contextBridge, ipcRenderer } = require('electron');

// No nodeIntegration in the renderer — this is the only bridge. Every TNC
// connection, serial port, and raw socket lives in the main process.
contextBridge.exposeInMainWorld('nexdigi', {
  listSerialPorts: () => ipcRenderer.invoke('serial:list'),

  listTncs: () => ipcRenderer.invoke('tnc:list'),
  createTnc: (config) => ipcRenderer.invoke('tnc:create', config),
  updateTnc: (tncId, patch) => ipcRenderer.invoke('tnc:update', tncId, patch),
  removeTnc: (tncId) => ipcRenderer.invoke('tnc:remove', tncId),
  connectTnc: (tncId) => ipcRenderer.invoke('tnc:connect', tncId),
  disconnectTnc: (tncId) => ipcRenderer.invoke('tnc:disconnect', tncId),

  addRadio: (tncId, radio) => ipcRenderer.invoke('radio:add', tncId, radio),
  removeRadio: (tncId, radioId) => ipcRenderer.invoke('radio:remove', tncId, radioId),

  sendUnproto: (tncId, radioId, dest, text) => ipcRenderer.invoke('terminal:sendUnproto', tncId, radioId, dest, text),
  startSession: (tncId, radioId, remoteCall) => ipcRenderer.invoke('terminal:startSession', tncId, radioId, remoteCall),
  sendSessionText: (sessionId, text) => ipcRenderer.invoke('terminal:sendSessionText', sessionId, text),
  endSession: (sessionId) => ipcRenderer.invoke('terminal:endSession', sessionId),

  onMonitor: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('monitor', l); return () => ipcRenderer.removeListener('monitor', l); },
  onTncStatus: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('tnc-status', l); return () => ipcRenderer.removeListener('tnc-status', l); },
  onTncListChanged: (cb) => { const l = () => cb(); ipcRenderer.on('tnc-list-changed', l); return () => ipcRenderer.removeListener('tnc-list-changed', l); },
  onSessionState: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('session-state', l); return () => ipcRenderer.removeListener('session-state', l); },
  onSessionData: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('session-data', l); return () => ipcRenderer.removeListener('session-data', l); }
});
