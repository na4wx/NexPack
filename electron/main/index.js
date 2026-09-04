const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const TncManager = require('./tnc/TncManager');
const ScriptManager = require('./tnc/ScriptManager');
const PatManager = require('./winlink/PatManager');
const AgwpeBridgeServer = require('./winlink/AgwpeBridgeServer');
const SoundModemManager = require('./soundmodem/SoundModemManager');
const NexDigiClient = require('./bbs/NexDigiClient');
const RfBbsClient = require('./bbs/RfBbsClient');
const BbsFacade = require('./bbs/BbsFacade');
const ChatManager = require('./chat/ChatManager');
const RfChatClient = require('./chat/RfChatClient');
const ChatFacade = require('./chat/ChatFacade');
const AprsManager = require('./aprs/AprsManager');
const MapTileCache = require('./maps/MapTileCache');
const TerminalSettings = require('./settings/TerminalSettings');
const InboundServerSettings = require('./settings/InboundServerSettings');
const AppSettings = require('./settings/AppSettings');
const InboundNodeServer = require('./tnc/InboundNodeServer');
const UpdateChecker = require('./UpdateChecker');

let mainWindow;
let tncManager;
let scriptManager;
let patManager;
let agwpeBridgeServer;
let soundModemManager;
let nexDigiClient;
let rfBbsClient;
let bbsFacade;
let chatManager;
let rfChatClient;
let chatFacade;
let aprsManager;
let mapTileCache;
let terminalSettings;
let inboundServerSettings;
let appSettings;
let inboundNodeServer;
let updateChecker;

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

app.whenReady().then(async () => {
  soundModemManager = new SoundModemManager({ userDataDir: app.getPath('userData'), resourcesPath: process.resourcesPath });
  tncManager = new TncManager({ configPath: path.join(app.getPath('userData'), 'tncs.json'), userDataDir: app.getPath('userData'), soundModemManager });
  scriptManager = new ScriptManager({ userDataDir: app.getPath('userData'), tncManager });
  // Lets `pat` (which can only ever speak AGWPE, never raw KISS) drive
  // Winlink RF through ANY of NexPack's own configured radios — see
  // AgwpeBridgeServer.js. patManager is referenced via closure since it's
  // constructed just below; getRadio() is only ever actually called later,
  // on an incoming connect, well after that assignment happens.
  agwpeBridgeServer = new AgwpeBridgeServer({ tncManager, getRadio: () => patManager.getRfRadio() });
  const agwpeBridgePort = await agwpeBridgeServer.start();
  patManager = new PatManager({ userDataDir: app.getPath('userData'), resourcesPath: process.resourcesPath, agwpeBridgePort });
  nexDigiClient = new NexDigiClient({ userDataDir: app.getPath('userData') });
  rfBbsClient = new RfBbsClient({ userDataDir: app.getPath('userData'), tncManager });
  bbsFacade = new BbsFacade({ userDataDir: app.getPath('userData'), nexDigiClient, rfBbsClient });
  chatManager = new ChatManager({ nexDigiClient });
  rfChatClient = new RfChatClient({ tncManager, rfBbsClient });
  chatFacade = new ChatFacade({ userDataDir: app.getPath('userData'), chatManager, rfChatClient });
  aprsManager = new AprsManager({ userDataDir: app.getPath('userData'), tncManager });
  mapTileCache = new MapTileCache({ userDataDir: app.getPath('userData') });
  terminalSettings = new TerminalSettings({ userDataDir: app.getPath('userData') });
  inboundServerSettings = new InboundServerSettings({ userDataDir: app.getPath('userData') });
  appSettings = new AppSettings({ userDataDir: app.getPath('userData') });
  inboundNodeServer = new InboundNodeServer({ tncManager, bbsFacade, nexDigiClient, terminalSettings, inboundServerSettings });
  updateChecker = new UpdateChecker({ currentVersion: app.getVersion() });

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

  soundModemManager.on('log', (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('soundmodem-log', payload); });
  // A direwolf crash after startup has no other listener to catch it —
  // same 'error'-with-zero-listeners crash class documented above for pat.
  soundModemManager.on('error', ({ tncId, error }) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('soundmodem-log', { tncId, line: `ERROR: ${error.message}\n` }); });

  // Both transports (ChatManager over HTTP/WS, RfChatClient over AX.25) are
  // forwarded to the same renderer channels — only one is ever active per
  // ChatFacade.getTransport(), and the renderer doesn't need to know which.
  for (const evt of ['chat-event', 'chat-error', 'chat-socket-closed']) {
    chatManager.on(evt, (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload); });
  }
  for (const evt of ['chat-event', 'chat-error']) {
    rfChatClient.on(evt, (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload); });
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

  // Auto-connect every configured TNC on launch — real packet radio
  // software behaves this way (plug in and go), rather than making the
  // user click Connect in TNCs & Radios every time the app starts. Runs
  // only after every relevant 'error' listener above is already wired
  // (soundModemManager's especially — an EventEmitter's 'error' with zero
  // listeners crashes the whole process, the same class of bug already
  // fixed for PatManager/TncManager itself). Best-effort: one TNC failing
  // to connect (radio unplugged, wrong port, etc.) doesn't block the rest,
  // and just leaves that TNC showing its real error status in the UI,
  // same as a manual Connect click would.
  for (const t of tncManager.listTncs()) {
    tncManager.connectTnc(t.id).catch((e) => console.error(`Auto-connect failed for TNC "${t.name}":`, e.message));
  }

  ipcMain.handle('serial:list', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || null }));
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('soundmodem:listAudioDevices', () => soundModemManager.listAudioDevices());

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
  ipcMain.handle('terminal:sendSessionText', (_e, sessionId, text) => tncManager.sendSessionLine(sessionId, text));
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
  ipcMain.handle('winlink:getRfRadio', () => patManager.getRfRadio());
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
  // Also forcibly cancels at the AGWPE bridge layer, not just pat's own
  // /api/disconnect — pat's AGWPE client has a confirmed bug where it
  // doesn't reliably react to that while actively dialing (see
  // PatManager.js's CONNECT_TIMEOUT_MS comment), which is exactly what
  // made "click Disconnect while it's still connecting" not actually work.
  ipcMain.handle('winlink:disconnect', async (_e, dirty) => {
    agwpeBridgeServer.cancelAll();
    // Best-effort: cancelAll() above already did the real work (ended the
    // AX.25 session, closed pat's socket to the bridge), so pat's own
    // /api/disconnect can legitimately 400 here — e.g. pat never
    // considered itself to have an active session in the first place if
    // it was cancelled mid-dial rather than mid-session (confirmed live).
    // That's not a real failure from the user's point of view; don't
    // surface it as one.
    try { await patManager.disconnect(dirty); } catch (e) { /* cancelAll() already handled the real disconnect */ }
  });
  ipcMain.handle('winlink:searchRms', (_e, params) => patManager.searchRms(params));

  ipcMain.handle('winlink:listFormCatalog', () => patManager.listFormCatalog());
  ipcMain.handle('winlink:updateForms', () => patManager.updateForms());
  // Opens the real, official Winlink form (rendered by pat itself) in its
  // own window and resolves once the user submits it (or null if they
  // close the window without submitting) — see PatManager.js's forms
  // comment for the full mechanism this replicates. Blocks the renderer's
  // call until one of those happens, same as winlink:connect blocking on
  // pat's own /api/connect.
  ipcMain.handle('winlink:openForm', async (_e, templatePath, inReplyTo) => {
    if (!patManager.port) throw new Error('Winlink is not running yet');
    const forminstanceId = String(Math.floor(1e9 * Math.random()));
    const origin = `http://127.0.0.1:${patManager.port}`;
    await session.defaultSession.cookies.set({
      url: origin,
      name: 'forminstance',
      value: forminstanceId,
      expirationDate: Math.floor(Date.now() / 1000) + 86400
    });
    const formWindow = new BrowserWindow({
      width: 900,
      height: 900,
      title: 'Winlink Form',
      parent: mainWindow,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    formWindow.loadURL(patManager.formUrl(templatePath, inReplyTo));

    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        if (!formWindow.isDestroyed()) formWindow.close();
        resolve(result);
      };
      pollTimer = setInterval(async () => {
        try {
          const result = await patManager.getFormResult(forminstanceId);
          if (result) finish(result);
        } catch (e) { /* keep polling */ }
      }, 1000);
      // The form's own real submit response closes this window itself
      // (confirmed: pat returns "<script>window.close()</script>"), which
      // usually races ahead of the next poll tick — check once more right
      // here rather than assuming a closed window means the user cancelled.
      formWindow.on('closed', async () => {
        if (settled) return;
        try {
          const result = await patManager.getFormResult(forminstanceId);
          finish(result || null);
        } catch (e) {
          finish(null);
        }
      });
    });
  });

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
  ipcMain.handle('chat:connect', () => chatFacade.connect());
  ipcMain.handle('chat:disconnect', () => chatFacade.disconnect());
  ipcMain.handle('chat:listRooms', () => chatFacade.listRooms());
  ipcMain.handle('chat:createRoom', (_e, name, description) => chatFacade.createRoom(name, description));
  ipcMain.handle('chat:switchRoom', (_e, name) => chatFacade.switchRoom(name));
  ipcMain.handle('chat:getRoomUsers', (_e, name) => chatFacade.getRoomUsers(name));
  ipcMain.handle('chat:sendMessage', (_e, text) => chatFacade.sendMessage(text));
  ipcMain.handle('chat:sendTyping', (_e, typing) => chatFacade.sendTyping(typing));
  ipcMain.handle('chatFacade:getTransport', () => chatFacade.getTransport());
  ipcMain.handle('chatFacade:setTransport', (_e, transport) => chatFacade.setTransport(transport));

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

  ipcMain.handle('maps:getTile', async (_e, z, x, y) => mapTileCache.getTile(z, x, y));
  ipcMain.handle('maps:getCacheInfo', () => mapTileCache.getCacheInfo());
  ipcMain.handle('maps:setCacheBudget', (_e, bytes) => mapTileCache.setBudget(bytes));
  ipcMain.handle('maps:clearCache', () => mapTileCache.clear());

  ipcMain.handle('terminal:getSettings', () => terminalSettings.getSettings());
  ipcMain.handle('terminal:saveSettings', (_e, settings) => terminalSettings.saveSettings(settings));
  ipcMain.handle('inboundServer:getSettings', () => inboundServerSettings.getSettings());
  ipcMain.handle('inboundServer:saveSettings', (_e, settings) => inboundServerSettings.saveSettings(settings));
  ipcMain.handle('app:getSettings', () => appSettings.getSettings());
  ipcMain.handle('app:saveSettings', (_e, settings) => appSettings.saveSettings(settings));

  ipcMain.handle('update:check', () => updateChecker.checkForUpdate());
  ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Launch-time check: silent on failure (offline, rate-limited, whatever —
  // this shouldn't nag or error out on every single startup) and only
  // interrupts the user with a real dialog when there's actually something
  // to offer. The in-app "Check for updates" button (Settings -> About)
  // covers the on-demand case and surfaces errors there instead.
  updateChecker.checkForUpdate().then((result) => {
    if (!result.updateAvailable || !mainWindow || mainWindow.isDestroyed()) return;
    return dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `NexPack ${result.latestVersion} is available — you have ${result.currentVersion}.`,
      detail: 'Open the release page to download it?'
    }).then(({ response }) => { if (response === 0) shell.openExternal(result.releaseUrl); });
  }).catch((e) => console.error('Startup update check failed (non-fatal):', e.message));
});

app.on('window-all-closed', () => {
  if (rfChatClient) rfChatClient.disconnect();
  if (agwpeBridgeServer) agwpeBridgeServer.stop();
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
  Promise.all([
    patManager ? patManager.stop() : null,
    soundModemManager ? soundModemManager.stopAll() : null
  ])
    .catch(() => {})
    .finally(() => app.quit());
});
