const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const TncManager = require('./tnc/TncManager');

let mainWindow;
let tncManager;

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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (tncManager) tncManager.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
