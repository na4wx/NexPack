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
  onSessionData: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('session-data', l); return () => ipcRenderer.removeListener('session-data', l); },

  // Winlink (bundled pat subprocess)
  winlinkGetSettings: () => ipcRenderer.invoke('winlink:getSettings'),
  winlinkSaveSettings: (settings) => ipcRenderer.invoke('winlink:saveSettings', settings),
  winlinkStart: () => ipcRenderer.invoke('winlink:start'),
  winlinkStop: () => ipcRenderer.invoke('winlink:stop'),
  winlinkListMessages: (folder) => ipcRenderer.invoke('winlink:listMessages', folder),
  winlinkGetMessage: (folder, mid) => ipcRenderer.invoke('winlink:getMessage', folder, mid),
  winlinkMarkRead: (folder, mid, read) => ipcRenderer.invoke('winlink:markRead', folder, mid, read),
  winlinkDeleteMessage: (folder, mid) => ipcRenderer.invoke('winlink:deleteMessage', folder, mid),
  winlinkArchiveMessage: (folder, mid) => ipcRenderer.invoke('winlink:archiveMessage', folder, mid),
  winlinkSendMessage: (message) => ipcRenderer.invoke('winlink:sendMessage', message),
  winlinkGetConnectAliases: () => ipcRenderer.invoke('winlink:getConnectAliases'),
  winlinkSetConnectAlias: (name, url) => ipcRenderer.invoke('winlink:setConnectAlias', name, url),
  winlinkRemoveConnectAlias: (name) => ipcRenderer.invoke('winlink:removeConnectAlias', name),
  winlinkConnect: (url) => ipcRenderer.invoke('winlink:connect', url),
  winlinkDisconnect: (dirty) => ipcRenderer.invoke('winlink:disconnect', dirty),
  winlinkSearchRms: (params) => ipcRenderer.invoke('winlink:searchRms', params),
  onWinlinkLog: (cb) => { const l = (_e, line) => cb(line); ipcRenderer.on('winlink-log', l); return () => ipcRenderer.removeListener('winlink-log', l); },
  onWinlinkStatus: (cb) => { const l = (_e, status) => cb(status); ipcRenderer.on('winlink-status', l); return () => ipcRenderer.removeListener('winlink-status', l); },

  // BBS (NexDigi server REST)
  bbsGetSettings: () => ipcRenderer.invoke('bbs:getSettings'),
  bbsSaveSettings: (settings) => ipcRenderer.invoke('bbs:saveSettings', settings),
  bbsListMessages: (filters) => ipcRenderer.invoke('bbs:listMessages', filters),
  bbsPostMessage: (message) => ipcRenderer.invoke('bbs:postMessage', message),
  bbsMarkRead: (messageNumber) => ipcRenderer.invoke('bbs:markRead', messageNumber),
  bbsDeleteMessage: (messageNumber) => ipcRenderer.invoke('bbs:deleteMessage', messageNumber),
  bbsListBulletins: () => ipcRenderer.invoke('bbs:listBulletins'),
  bbsGetStats: () => ipcRenderer.invoke('bbs:getStats'),

  // Chat (NexDigi server REST + shared WebSocket)
  chatConnect: () => ipcRenderer.invoke('chat:connect'),
  chatDisconnect: () => ipcRenderer.invoke('chat:disconnect'),
  chatListRooms: () => ipcRenderer.invoke('chat:listRooms'),
  chatCreateRoom: (name, description) => ipcRenderer.invoke('chat:createRoom', name, description),
  chatSwitchRoom: (name) => ipcRenderer.invoke('chat:switchRoom', name),
  chatGetRoomUsers: (name) => ipcRenderer.invoke('chat:getRoomUsers', name),
  chatSendMessage: (text) => ipcRenderer.invoke('chat:sendMessage', text),
  chatSendTyping: (typing) => ipcRenderer.invoke('chat:sendTyping', typing),
  // A single generic event carries every real server message (see
  // ChatManager.js for why — the server's own 'chat-broadcast' wrapper type
  // never actually arrives on the wire; this dispatches on msg.type itself).
  onChatEvent: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('chat-event', l); return () => ipcRenderer.removeListener('chat-event', l); },
  onChatError: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('chat-error', l); return () => ipcRenderer.removeListener('chat-error', l); },
  onChatSocketClosed: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('chat-socket-closed', l); return () => ipcRenderer.removeListener('chat-socket-closed', l); },

  // APRS (RF via TncManager, always-on; APRS-IS optional)
  aprsGetStations: () => ipcRenderer.invoke('aprs:getStations'),
  aprsGetSettings: () => ipcRenderer.invoke('aprs:getSettings'),
  aprsSaveSettings: (settings) => ipcRenderer.invoke('aprs:saveSettings', settings),
  aprsConnectAprsIs: () => ipcRenderer.invoke('aprs:connectAprsIs'),
  aprsDisconnectAprsIs: () => ipcRenderer.invoke('aprs:disconnectAprsIs'),
  onAprsStation: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('aprs-station', l); return () => ipcRenderer.removeListener('aprs-station', l); },
  onAprsIsStatus: (cb) => { const l = (_e, evt) => cb(evt); ipcRenderer.on('aprs-is-status', l); return () => ipcRenderer.removeListener('aprs-is-status', l); }
});
