const net = require('net');
const EventEmitter = require('events');

// A local AGWPE server that lets `pat` (which can only ever speak AGWPE or
// a real serial TNC — see TncManager.js's own AX.25 stack for why that's
// not true of the rest of this app) drive a real AX.25 connected-mode
// session through NexPack's OWN TncManager instead of requiring a separate
// AGWPE-speaking TNC. This is what lets Winlink RF use ANY radio already
// configured in TNCs & Radios — serial, KISS-TCP, AGWPE passthrough, or
// the built-in Sound Modem — the same set Terminal/BBS/Chat/APRS use.
//
// The AGWPE frame format and the specific commands implemented here
// (X/register, C/connect, D/data, d/disconnect, R/version, G/port info,
// g/port capabilities, y/Y/outstanding-frame counts) are taken from the
// original SV2AGW "AGWPE TCP/IP API Tutorial" spec, cross-checked against a
// real captured exchange between the actual bundled `pat` binary and a
// real Direwolf AGWPE server (pat, in practice, only ever sends
// g/X/R/C/D/d/Y — G is handled defensively for other AGWPE clients/pat
// versions that might use it).
//
// Frame header (36 bytes, always present, LE integers):
//   0      Port (radio port index)
//   1-3    reserved
//   4      DataKind (ASCII command letter)
//   5      reserved
//   6      PID
//   7      reserved
//   8-17   CallFrom (10 bytes, NUL-padded ASCII)
//   18-27  CallTo (10 bytes, NUL-padded ASCII)
//   28-31  DataLen (uint32 LE) — payload byte count following the header
//   32-35  User (reserved, unused)
const HEADER_LEN = 36;

function readCall(buf, offset) {
  return buf.slice(offset, offset + 10).toString('ascii').replace(/\0.*$/, '').trim().toUpperCase();
}

function writeCall(str) {
  const buf = Buffer.alloc(10);
  buf.write(String(str || '').toUpperCase().slice(0, 9), 'ascii');
  return buf;
}

function buildFrame({ port = 0, kind, pid = 0, callFrom = '', callTo = '', payload = Buffer.alloc(0) }) {
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = port & 0xff;
  header[4] = kind.charCodeAt(0);
  header[6] = pid & 0xff;
  writeCall(callFrom).copy(header, 8);
  writeCall(callTo).copy(header, 18);
  header.writeUInt32LE(payload.length, 28);
  return Buffer.concat([header, payload]);
}

class AgwpeBridgeServer extends EventEmitter {
  // getRadio(): () => {tncId, radioId} | null — resolved fresh on every
  // connect attempt (not cached), same reasoning as PatManager's old
  // _resolveAgwpeConfig: the configured radio can change between connects.
  constructor({ tncManager, getRadio }) {
    super();
    this.tncManager = tncManager;
    this.getRadio = getRadio;
    this.server = null;
    this.port = null;
    // sessionId -> { socket, callFrom, callTo, port, buf }
    this.sessions = new Map();
    // socket -> Set(sessionId), for cleanup when pat disconnects from us
    this.socketSessions = new Map();

    this._onSessionState = (snap) => {
      const entry = this.sessions.get(snap.id);
      if (!entry) return;
      if (snap.state === 'connected') {
        const text = `*** CONNECTED To Station ${entry.callTo}\r`;
        entry.socket.write(buildFrame({ port: entry.port, kind: 'C', callFrom: entry.callFrom, callTo: entry.callTo, payload: Buffer.from(text, 'ascii') }));
      } else if (snap.state === 'disconnected') {
        this._sendDisconnect(entry, `*** DISCONNECTED From Station ${entry.callTo}\r`);
      }
    };
    this._onSessionError = ({ sessionId, message }) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      this._sendDisconnect(entry, `*** DISCONNECTED From Station ${entry.callTo} (${message})\r`);
    };
    this._onSessionData = ({ sessionId, raw }) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      entry.socket.write(buildFrame({ port: entry.port, kind: 'D', pid: 0xf0, callFrom: entry.callTo, callTo: entry.callFrom, payload: raw }));
    };
  }

  _sendDisconnect(entry, text) {
    entry.socket.write(buildFrame({ port: entry.port, kind: 'd', callFrom: entry.callFrom, callTo: entry.callTo, payload: Buffer.from(text, 'ascii') }));
    this.sessions.delete(entry.sessionId);
    const set = this.socketSessions.get(entry.socket);
    if (set) set.delete(entry.sessionId);
  }

  async start() {
    if (this.server) return this.port;
    this.tncManager.on('session-state', this._onSessionState);
    this.tncManager.on('session-error', this._onSessionError);
    this.tncManager.on('session-data', this._onSessionData);
    this.port = await new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => this._handleSocket(socket));
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
      this.server = srv;
    });
    return this.port;
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } this.server = null; }
    this.tncManager.removeListener('session-state', this._onSessionState);
    this.tncManager.removeListener('session-error', this._onSessionError);
    this.tncManager.removeListener('session-data', this._onSessionData);
    for (const sessionId of this.sessions.keys()) { try { this.tncManager.endSession(sessionId); } catch (e) { /* ignore */ } }
    this.sessions.clear();
    this.socketSessions.clear();
  }

  _handleSocket(socket) {
    let buf = Buffer.alloc(0);
    this.socketSessions.set(socket, new Set());
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= HEADER_LEN) {
        const dataLen = buf.readUInt32LE(28);
        if (buf.length < HEADER_LEN + dataLen) break; // wait for the rest of this frame
        const header = buf.slice(0, HEADER_LEN);
        const payload = buf.slice(HEADER_LEN, HEADER_LEN + dataLen);
        buf = buf.slice(HEADER_LEN + dataLen);
        try { this._handleFrame(socket, header, payload); } catch (e) { this.emit('log', `AGWPE bridge error: ${e.message}\n`); }
      }
    });
    socket.on('error', () => { /* client went away — cleaned up on 'close' */ });
    socket.on('close', () => {
      const set = this.socketSessions.get(socket);
      if (set) { for (const sessionId of set) { try { this.tncManager.endSession(sessionId); } catch (e) { /* ignore */ } this.sessions.delete(sessionId); } }
      this.socketSessions.delete(socket);
    });
  }

  _handleFrame(socket, header, payload) {
    const port = header[0];
    const kind = String.fromCharCode(header[4]);
    const pid = header[6];
    const callFrom = readCall(header, 8);
    const callTo = readCall(header, 18);

    switch (kind) {
      case 'X': { // register callsign — accepted unconditionally, this is a private local bridge
        socket.write(buildFrame({ port, kind: 'X', callFrom, payload: Buffer.from([0x01]) }));
        break;
      }
      case 'R': { // version query
        socket.write(buildFrame({ port, kind: 'R', payload: Buffer.concat([u32le(1), u32le(0)]) }));
        break;
      }
      case 'G': { // port information (text): "<n>;Port1 <name>;..."
        const text = `1;Port1 NexPack Bridge\0`;
        socket.write(buildFrame({ port, kind: 'G', payload: Buffer.from(text, 'ascii') }));
        break;
      }
      case 'g': { // port capabilities (binary) — values here aren't acted on by pat, only the presence of a reply matters
        socket.write(buildFrame({ port, kind: 'g', payload: Buffer.alloc(12) }));
        break;
      }
      case 'y': { // outstanding frames on port
        socket.write(buildFrame({ port, kind: 'y', payload: u32le(0) }));
        break;
      }
      case 'Y': { // outstanding frames on a specific connection
        socket.write(buildFrame({ port, kind: 'Y', callFrom, callTo, payload: u32le(0) }));
        break;
      }
      case 'C': { // connect request
        this._handleConnect(socket, port, pid, callFrom, callTo);
        break;
      }
      case 'D': { // send connected data
        const found = this._findSessionByPair(callFrom, callTo);
        if (found) { try { this.tncManager.sendSessionRaw(found.sessionId, payload); } catch (e) { this.emit('log', `AGWPE bridge: send failed: ${e.message}\n`); } }
        break;
      }
      case 'd': { // disconnect request
        const found = this._findSessionByPair(callFrom, callTo);
        if (found) { try { this.tncManager.endSession(found.sessionId); } catch (e) { /* ignore */ } }
        break;
      }
      default:
        // Unrecognized/unused command (m, k, X unregister, etc.) — silently ignored, matching how a real
        // AGWPE server behaves toward a command it doesn't implement rather than dropping the connection.
        break;
    }
  }

  _findSessionByPair(callFrom, callTo) {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.callFrom === callFrom.toUpperCase() && entry.callTo === callTo.toUpperCase()) return { sessionId, entry };
    }
    return null;
  }

  async _handleConnect(socket, port, pid, callFrom, callTo) {
    const radio = this.getRadio && this.getRadio();
    if (!radio || !radio.tncId || !radio.radioId) {
      this._sendDisconnect({ socket, callFrom, callTo, port, sessionId: null }, `*** DISCONNECTED From Station ${callTo} (no radio configured for Winlink RF)\r`);
      return;
    }
    try {
      await this._ensureRadioConnected(radio.tncId);
      const snap = this.tncManager.startSession(radio.tncId, radio.radioId, callTo);
      const entry = { socket, callFrom: callFrom.toUpperCase(), callTo: callTo.toUpperCase(), port, sessionId: snap.id };
      this.sessions.set(snap.id, entry);
      const set = this.socketSessions.get(socket);
      if (set) set.add(snap.id);
    } catch (e) {
      this._sendDisconnect({ socket, callFrom, callTo, port, sessionId: null }, `*** DISCONNECTED From Station ${callTo} (${e.message})\r`);
    }
  }

  // TncManager.connectTnc() resolves as soon as it STARTS connecting a
  // serial/KISS-TCP/AGWPE radio — not once it's actually open (only a
  // 'soundmodem' radio's promise really waits, since it has to wait on a
  // Direwolf subprocess). Every other UI path in this app is fine with
  // that because a human is in the loop between "connect the radio" and
  // "start a session" — this bridge isn't, and calling startSession()
  // immediately after connectTnc() raced ahead of the adapter actually
  // opening, silently dropping the very first SABM into a socket/port
  // that wasn't ready yet (confirmed live: nothing transmitted at all,
  // and pat just sat there until its own 120s timeout — a real bug, not a
  // "no RF answer" case). Waits for a real 'tnc-status' 'connected' (or
  // 'error') event instead of trusting connectTnc()'s promise.
  _ensureRadioConnected(tncId) {
    const isConnected = () => {
      const t = this.tncManager.listTncs().find((x) => x.id === tncId);
      return !!t && t.status === 'connected';
    };
    if (isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('radio did not finish connecting in time')); }, 10000);
      const onStatus = (evt) => {
        if (evt.tncId !== tncId) return;
        if (evt.status === 'connected') { cleanup(); resolve(); }
        else if (evt.status === 'error') { cleanup(); reject(new Error(evt.error || 'radio failed to connect')); }
      };
      const cleanup = () => { clearTimeout(timer); this.tncManager.removeListener('tnc-status', onStatus); };
      this.tncManager.on('tnc-status', onStatus);
      this.tncManager.connectTnc(tncId).catch((e) => { cleanup(); reject(e); });
    });
  }
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

module.exports = AgwpeBridgeServer;
