const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const TncManager = require('./tnc/TncManager');
const ScriptManager = require('./tnc/ScriptManager');
const PatManager = require('./winlink/PatManager');
const NexDigiClient = require('./bbs/NexDigiClient');
const RfBbsClient = require('./bbs/RfBbsClient');
const BbsFacade = require('./bbs/BbsFacade');
const ChatManager = require('./chat/ChatManager');
const AprsManager = require('./aprs/AprsManager');

let mainWindow;
let tncManager;
let scriptManager;
let patManager;
let nexDigiClient;
let rfBbsClient;
let bbsFacade;
let chatManager;
let aprsManager;

function forwardToRenderer(eventName) {
  tncManager.on(eventName, (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventName, payload);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5180');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  tncManager = new TncManager({ configPath: path.join(app.getPath('userData'), 'tncs.json'), userDataDir: app.getPath('userData') });
  scriptManager = new ScriptManager({ userDataDir: app.getPath('userData'), tncManager });
  patManager = new PatManager({ userDataDir: app.getPath('userData'), resourcesPath: process.resourcesPath });
  nexDigiClient = new NexDigiClient({ userDataDir: app.getPath('userData') });
  rfBbsClient = new RfBbsClient({ userDataDir: app.getPath('userData'), tncManager });
  bbsFacade = new BbsFacade({ userDataDir: app.getPath('userData'), nexDigiClient, rfBbsClient });
  chatManager = new ChatManager({ nexDigiClient });
  aprsManager = new AprsManager({ userDataDir: app.getPath('userData'), tncManager });

  // TncManager only emits its own 'error' (as opposed to per-adapter errors,
  // which it already absorbs itself) when persisting tncs.json fails — rare,
  // but with no listener at all Node throws and takes down the whole app,
  // the same crash class just fixed for PatManager above.
  tncManager.on('error', (err) => console.error('TncManager error:', err));

  patManager.on('log', (line) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winlink-log', line); });
  patManager.on('status', (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winlink-status', status); });
  // Without this listener, PatManager emitting 'error' (e.g. a spawn
  // failure well after start() has already resolved) would crash the
  // entire Electron process — Node throws when 'error' has no listeners.
  patManager.on('error', (err) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winlink-log', `ERROR: ${err.message}\n`); });

  for (const evt of ['chat-event', 'chat-error', 'chat-socket-closed']) {
    chatManager.on(evt, (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload); });
  }

  for (const evt of ['aprs-station', 'aprs-is-status', 'aprs-message', 'aprs-object', 'aprs-beacon-sent', 'aprs-error']) {
    aprsManager.on(evt, (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload); });
  }

  forwardToRenderer('monitor');
  forwardToRenderer('tnc-status');
  forwardToRenderer('tnc-list-changed');
  forwardToRenderer('session-state');
  forwardToRenderer('session-data');
  forwardToRenderer('session-tx');
  forwardToRenderer('session-error');
  forwardToRenderer('file-transfer-offer');
  forwardToRenderer('file-transfer-progress');
  forwardToRenderer('file-transfer-complete');
  forwardToRenderer('file-transfer-error');
  forwardToRenderer('script-complete');
  forwardToRenderer('script-error');

  ipcMain.handle('serial:list', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || null }));
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('tnc:list', () => tncManager.listTncs());
  ipcMain.handle('tnc:create', (_e, config) => tncManager.createTnc(config));
  ipcMain.handle('tnc:update', (_e, tncId, patch) => tncManager.updateTnc(tncId, patch));
  ipcMain.handle('tnc:remove', (_e, tncId) => tncManager.removeTnc(tncId));
  ipcMain.handle('tnc:connect', (_e, tncId) => tncManager.connectTnc(tncId));
  ipcMain.handle('tnc:disconnect', (_e, tncId) => tncManager.disconnectTnc(tncId));

  ipcMain.handle('radio:add', (_e, tncId, radio) => tncManager.addRadio(tncId, radio));
  ipcMain.handle('radio:remove', (_e, tncId, radioId) => tncManager.removeRadio(tncId, radioId));

  ipcMain.handle('terminal:sendUnproto', (_e, tncId, radioId, dest, text) => tncManager.sendUnproto(tncId, radioId, dest, text));
  ipcMain.handle('terminal:startSession', (_e, tncId, radioId, remoteCall, digiPath, scriptId) => tncManager.startSession(tncId, radioId, remoteCall, digiPath, scriptId));
  ipcMain.handle('terminal:sendSessionText', (_e, sessionId, text) => tncManager.sendSessionText(sessionId, text));
  ipcMain.handle('terminal:endSession', (_e, sessionId) => tncManager.endSession(sessionId));

  ipcMain.handle('terminal:pickFileToSend', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('terminal:pickSaveLocation', async (_e, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('terminal:sendFile', (_e, sessionId, filePath) => tncManager.startFileSend(sessionId, filePath));
  ipcMain.handle('terminal:respondFileOffer', (_e, sessionId, accept, savePath) => tncManager.respondToFileOffer(sessionId, accept, savePath));
  ipcMain.handle('terminal:abortFileTransfer', (_e, sessionId) => tncManager.abortFileTransfer(sessionId));

  ipcMain.handle('scripts:list', () => scriptManager.listScripts());
  ipcMain.handle('scripts:save', (_e, script) => scriptManager.saveScript(script));
  ipcMain.handle('scripts:delete', (_e, scriptId) => scriptManager.deleteScript(scriptId));
  ipcMain.handle('scripts:run', (_e, sessionId, scriptId) => scriptManager.runScript(sessionId, scriptId));
  ipcMain.handle('scripts:abort', (_e, sessionId) => scriptManager.abortScript(sessionId));

  // Winlink (via bundled pat subprocess)
  ipcMain.handle('winlink:getSettings', () => patManager.getSettings());
  ipcMain.handle('winlink:saveSettings', (_e, settings) => patManager.saveSettings(settings));
  ipcMain.handle('winlink:start', () => patManager.start());
  ipcMain.handle('winlink:stop', () => patManager.stop());
  ipcMain.handle('winlink:listMessages', (_e, folder) => patManager.listMessages(folder));
  ipcMain.handle('winlink:getMessage', (_e, folder, mid) => patManager.getMessage(folder, mid));
  ipcMain.handle('winlink:markRead', (_e, folder, mid, read) => patManager.markRead(folder, mid, read));
  ipcMain.handle('winlink:deleteMessage', (_e, folder, mid) => patManager.deleteMessage(folder, mid));
  ipcMain.handle('winlink:archiveMessage', (_e, folder, mid) => patManager.archiveMessage(folder, mid));
  ipcMain.handle('winlink:sendMessage', (_e, message) => patManager.sendMessage(message));
  ipcMain.handle('winlink:getConnectAliases', () => patManager.getConnectAliases());
  ipcMain.handle('winlink:setConnectAlias', (_e, name, url) => patManager.setConnectAlias(name, url));
  ipcMain.handle('winlink:removeConnectAlias', (_e, name) => patManager.removeConnectAlias(name));
  ipcMain.handle('winlink:connect', (_e, url) => patManager.connect(url));
  ipcMain.handle('winlink:disconnect', (_e, dirty) => patManager.disconnect(dirty));
  ipcMain.handle('winlink:searchRms', (_e, params) => patManager.searchRms(params));

  // BBS (via NexDigi server REST, or over RF — routed by BbsFacade based on the active transport)
  ipcMain.handle('bbs:getSettings', () => nexDigiClient.getSettings());
  ipcMain.handle('bbs:saveSettings', (_e, settings) => nexDigiClient.saveSettings(settings));
  ipcMain.handle('bbs:listMessages', (_e, filters) => bbsFacade.listMessages(filters));
  ipcMain.handle('bbs:postMessage', (_e, message) => bbsFacade.postMessage(message));
  ipcMain.handle('bbs:markRead', (_e, messageNumber) => bbsFacade.markRead(messageNumber));
  ipcMain.handle('bbs:deleteMessage', (_e, messageNumber) => bbsFacade.deleteMessage(messageNumber));
  ipcMain.handle('bbs:listBulletins', () => bbsFacade.listBulletins());
  ipcMain.handle('bbs:getStats', () => bbsFacade.getStats());
  ipcMain.handle('bbsFacade:getTransport', () => bbsFacade.getTransport());
  ipcMain.handle('bbsFacade:setTransport', (_e, transport) => bbsFacade.setTransport(transport));
  ipcMain.handle('rfBbs:getSettings', () => rfBbsClient.getSettings());
  ipcMain.handle('rfBbs:saveSettings', (_e, settings) => rfBbsClient.saveSettings(settings));

  // Chat (via NexDigi server REST + shared WebSocket)
  ipcMain.handle('chat:connect', () => chatManager.connect());
  ipcMain.handle('chat:disconnect', () => chatManager.disconnect());
  ipcMain.handle('chat:listRooms', () => chatManager.listRooms());
  ipcMain.handle('chat:createRoom', (_e, name, description) => chatManager.createRoom(name, description));
  ipcMain.handle('chat:switchRoom', (_e, name) => chatManager.switchRoom(name));
  ipcMain.handle('chat:getRoomUsers', (_e, name) => chatManager.getRoomUsers(name));
  ipcMain.handle('chat:sendMessage', (_e, text) => chatManager.sendMessage(text));
  ipcMain.handle('chat:sendTyping', (_e, typing) => chatManager.sendTyping(typing));

  // APRS (RF via TncManager, always-on if TNCs are configured; APRS-IS optional)
  ipcMain.handle('aprs:getStations', () => aprsManager.getStations());
  ipcMain.handle('aprs:getSettings', () => aprsManager.getSettings());
  ipcMain.handle('aprs:saveSettings', (_e, settings) => aprsManager.saveSettings(settings));
  ipcMain.handle('aprs:connectAprsIs', () => aprsManager.connectAprsIs());
  ipcMain.handle('aprs:disconnectAprsIs', () => aprsManager.disconnectAprsIs());
  ipcMain.handle('aprs:getMyStation', () => aprsManager.getMyStation());
  ipcMain.handle('aprs:saveMyStation', (_e, myStation) => aprsManager.saveMyStation(myStation));
  ipcMain.handle('aprs:beaconNow', () => aprsManager.beaconNow());
  ipcMain.handle('aprs:sendMessage', (_e, toCallsign, text) => aprsManager.sendMessage(toCallsign, text));
  ipcMain.handle('aprs:cancelMessage', (_e, msgId) => aprsManager.cancelMessage(msgId));
  ipcMain.handle('aprs:getMessages', () => aprsManager.getMessages());
  ipcMain.handle('aprs:markMessageRead', (_e, id) => aprsManager.markMessageRead(id));
  ipcMain.handle('aprs:createObject', (_e, name, opts) => aprsManager.createObject(name, opts));
  ipcMain.handle('aprs:killObject', (_e, name) => aprsManager.killObject(name));
  ipcMain.handle('aprs:getObjects', () => aprsManager.getObjects());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (tncManager) tncManager.shutdown();
  if (chatManager) chatManager.disconnect();
  if (aprsManager) aprsManager.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

// `stop()` is async (SIGTERM, then SIGKILL after a grace period) so pat
// isn't orphaned on a clean quit — that's the case start()'s stale-process
// reaper can't help with, since the reaper only runs on the *next* launch.
// A crash or `kill -9` still can't be caught here (nothing in Node can);
// the startup reaper in PatManager.start() is the real backstop for that.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  Promise.resolve(patManager ? patManager.stop() : null)
    .catch(() => {})
    .finally(() => app.quit());
});
