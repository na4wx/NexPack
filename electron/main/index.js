const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const TncManager = require('./tnc/TncManager');
const PatManager = require('./winlink/PatManager');
const NexDigiClient = require('./bbs/NexDigiClient');
const ChatManager = require('./chat/ChatManager');

let mainWindow;
let tncManager;
let patManager;
let nexDigiClient;
let chatManager;

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
  tncManager = new TncManager({ configPath: path.join(app.getPath('userData'), 'tncs.json') });
  patManager = new PatManager({ userDataDir: app.getPath('userData'), resourcesPath: process.resourcesPath });
  nexDigiClient = new NexDigiClient({ userDataDir: app.getPath('userData') });
  chatManager = new ChatManager({ nexDigiClient });

  patManager.on('log', (line) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winlink-log', line); });
  patManager.on('status', (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winlink-status', status); });

  for (const evt of ['chat-event', 'chat-error', 'chat-socket-closed']) {
    chatManager.on(evt, (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload); });
  }

  forwardToRenderer('monitor');
  forwardToRenderer('tnc-status');
  forwardToRenderer('tnc-list-changed');
  forwardToRenderer('session-state');
  forwardToRenderer('session-data');

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
  ipcMain.handle('terminal:startSession', (_e, tncId, radioId, remoteCall) => tncManager.startSession(tncId, radioId, remoteCall));
  ipcMain.handle('terminal:sendSessionText', (_e, sessionId, text) => tncManager.sendSessionText(sessionId, text));
  ipcMain.handle('terminal:endSession', (_e, sessionId) => tncManager.endSession(sessionId));

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

  // BBS (via NexDigi server REST)
  ipcMain.handle('bbs:getSettings', () => nexDigiClient.getSettings());
  ipcMain.handle('bbs:saveSettings', (_e, settings) => nexDigiClient.saveSettings(settings));
  ipcMain.handle('bbs:listMessages', (_e, filters) => nexDigiClient.listMessages(filters));
  ipcMain.handle('bbs:postMessage', (_e, message) => nexDigiClient.postMessage(message));
  ipcMain.handle('bbs:markRead', (_e, messageNumber) => nexDigiClient.markRead(messageNumber));
  ipcMain.handle('bbs:deleteMessage', (_e, messageNumber) => nexDigiClient.deleteMessage(messageNumber));
  ipcMain.handle('bbs:listBulletins', () => nexDigiClient.listBulletins());
  ipcMain.handle('bbs:getStats', () => nexDigiClient.getStats());

  // Chat (via NexDigi server REST + shared WebSocket)
  ipcMain.handle('chat:connect', () => chatManager.connect());
  ipcMain.handle('chat:disconnect', () => chatManager.disconnect());
  ipcMain.handle('chat:listRooms', () => chatManager.listRooms());
  ipcMain.handle('chat:createRoom', (_e, name, description) => chatManager.createRoom(name, description));
  ipcMain.handle('chat:switchRoom', (_e, name) => chatManager.switchRoom(name));
  ipcMain.handle('chat:getRoomUsers', (_e, name) => chatManager.getRoomUsers(name));
  ipcMain.handle('chat:sendMessage', (_e, text) => chatManager.sendMessage(text));
  ipcMain.handle('chat:sendTyping', (_e, typing) => chatManager.sendTyping(typing));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (tncManager) tncManager.shutdown();
  if (chatManager) chatManager.disconnect();
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
