const EventEmitter = require('events');
const net = require('net');

// Real AGWPE binary protocol client. This does NOT exist anywhere in the
// NexDigi server (its soundmodemAdapter.js's "AGW" path is actually plain
// KISS-TCP passthrough, confirmed by reading its source) — built fresh here
// against the public AGWPE spec (SV2AGW "AGWPE API", also documented at
// uz7.ho.ua/includes/agwpeapi.htm), which is what Direwolf, UZ7HO
// SoundModem, and hardware AGWPE servers all implement.
//
// Frame header is a fixed 36 bytes:
//   uint8  port, reserved, reserved, reserved
//   uint8  dataKind (ascii command letter), reserved, pid, reserved
//   char   callFrom[10]
//   char   callTo[10]
//   uint32 dataLen (LE)
//   uint32 user (LE)
// followed by `dataLen` bytes of payload.
//
// One AGWPE TCP connection multiplexes every radio port the TNC exposes —
// this is the adapter that gives "multiple radios per TNC" its real meaning.
const HEADER_LEN = 36;

function buildHeader({ port = 0, dataKind, pid = 0, callFrom = '', callTo = '', dataLen = 0 }) {
  const h = Buffer.alloc(HEADER_LEN);
  h.writeUInt8(port & 0xff, 0);
  h.write(dataKind, 4, 1, 'ascii');
  h.writeUInt8(pid & 0xff, 6);
  h.write((callFrom || '').toUpperCase().slice(0, 9), 8, 10, 'ascii');
  h.write((callTo || '').toUpperCase().slice(0, 9), 18, 10, 'ascii');
  h.writeUInt32LE(dataLen >>> 0, 28);
  h.writeUInt32LE(0, 32);
  return h;
}

function buildAgwFrame(opts) {
  const payload = opts.data ? (Buffer.isBuffer(opts.data) ? opts.data : Buffer.from(opts.data)) : Buffer.alloc(0);
  const header = buildHeader({ ...opts, dataLen: payload.length });
  return Buffer.concat([header, payload]);
}

function readCall(header, offset) {
  return header.toString('ascii', offset, offset + 10).replace(/\0.*$/, '').trim().toUpperCase();
}

class AgwpeAdapter extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 8000, callsign = 'N0CALL', reconnectMs = 5000 }) {
    super();
    this.host = host;
    this.port = port;
    this.callsign = callsign;
    this.reconnectMs = reconnectMs;
    this.transport = 'agwpe';
    this.isSerial = false;
    this._closed = false;
    this._rxBuffer = Buffer.alloc(0);
    this.portInfo = [];
    this._connect();
  }

  _connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on('connect', () => {
      // Register our callsign, then ask for port info, then enable raw-frame monitoring.
      this._send(buildAgwFrame({ dataKind: 'X', callFrom: this.callsign }));
      this._send(buildAgwFrame({ dataKind: 'G' }));
      this._send(buildAgwFrame({ dataKind: 'k' }));
      this.emit('open');
    });
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => {
      this.emit('close');
      if (!this._closed) this._reconnectTimer = setTimeout(() => this._connect(), this.reconnectMs);
    });
  }

  _onData(chunk) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);
    while (this._rxBuffer.length >= HEADER_LEN) {
      const dataLen = this._rxBuffer.readUInt32LE(28);
      if (this._rxBuffer.length < HEADER_LEN + dataLen) break; // wait for more
      const header = this._rxBuffer.slice(0, HEADER_LEN);
      const data = this._rxBuffer.slice(HEADER_LEN, HEADER_LEN + dataLen);
      this._rxBuffer = this._rxBuffer.slice(HEADER_LEN + dataLen);
      this._handleFrame(header, data);
    }
  }

  _handleFrame(header, data) {
    const port = header.readUInt8(0);
    const dataKind = header.toString('ascii', 4, 5);
    if (dataKind === 'K') {
      // Raw heard/received AX.25 frame (full addressing+control+pid+payload).
      // AGWPE prefixes 'K' frames with a 1-byte "kind" indicator (0=UI,...);
      // callers of this adapter want the AX.25 frame itself.
      const ax25Frame = data.length > 0 ? data.slice(1) : data;
      this.emit('frame', { port, ax25Frame });
    } else if (dataKind === 'G') {
      const text = data.toString('ascii').replace(/\0+$/, '');
      const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
      // First entry is the port count; remaining entries are "Port N callsign ..." descriptions.
      this.portInfo = parts.slice(1);
      this.emit('portInfo', this.portInfo);
    } else if (dataKind === 'X') {
      this.emit('registered', data.length > 0 ? data.readUInt8(0) === 1 : true);
    } else if (dataKind === 'C') {
      // Native connected-mode session established (either our own outbound
      // 'C' request succeeded, or a remote station connected to us) — see
      // connectSession()/sendSessionData()/disconnectSession() below for
      // why this app uses these instead of injecting a raw SABM via 'K'.
      this.emit('session-connected', { port, callFrom: readCall(header, 8), callTo: readCall(header, 18), text: data.toString('ascii') });
    } else if (dataKind === 'D') {
      this.emit('session-data', { port, callFrom: readCall(header, 8), callTo: readCall(header, 18), payload: data });
    } else if (dataKind === 'd') {
      this.emit('session-disconnected', { port, callFrom: readCall(header, 8), callTo: readCall(header, 18), text: data.toString('ascii') });
    }
    // Other dataKinds (heard-list 'H', outstanding-frame counts 'y'/'Y',
    // etc.) are out of scope — not needed for anything this app does.
  }

  _send(buf) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(buf);
  }

  // Sends a raw, already-built AX.25 frame (ax25.js's buildAx25Frame) out a
  // given AGWPE port via 'K' — per the real AGWPE spec (on7lds.net's
  // AGWPEAPI.HTM), 'K' is meant for UI/unconnected traffic (APRS beacons,
  // monitoring), and while the spec allows using it for connected-mode
  // frames too ("could be used to send both connected and unconnected
  // information"), it explicitly recommends against it: "'K' frame should
  // be reserved for exceptional cases requiring raw control." Confirmed
  // live: a real external AGWPE server (UZ7HO Soundmodem) never keyed the
  // transmitter at all for a raw SABM sent this way — its own connected-
  // mode dispatcher was never told a session was starting, since that's
  // what 'C' is for (see connectSession() below). Only used for UI now
  // (sendUnproto() in TncManager.js) — TncManager's own connected-mode
  // session methods use connectSession()/sendSessionData()/
  // disconnectSession() instead, letting the AGWPE server manage the
  // AX.25 connection itself, exactly as the spec intends.
  sendFrame(port, ax25Frame, { callFrom, callTo } = {}) {
    if (!this.socket || this.socket.destroyed) return this.emit('error', new Error('AGWPE socket not connected'));
    this._send(buildAgwFrame({ port, dataKind: 'K', callFrom: callFrom || this.callsign, callTo: callTo || 'CQ', data: Buffer.concat([Buffer.from([0]), ax25Frame]) }));
  }

  // Native connected-mode session control — the spec-correct way to drive
  // an AX.25 connection through a real external AGWPE server (see the long
  // comment on sendFrame() above for why 'K' isn't used for this).
  connectSession(port, callFrom, callTo) {
    if (!this.socket || this.socket.destroyed) return this.emit('error', new Error('AGWPE socket not connected'));
    this._send(buildAgwFrame({ port, dataKind: 'C', callFrom, callTo }));
  }

  sendSessionData(port, callFrom, callTo, data) {
    if (!this.socket || this.socket.destroyed) return this.emit('error', new Error('AGWPE socket not connected'));
    this._send(buildAgwFrame({ port, dataKind: 'D', pid: 0xf0, callFrom, callTo, data }));
  }

  disconnectSession(port, callFrom, callTo) {
    if (!this.socket || this.socket.destroyed) return this.emit('error', new Error('AGWPE socket not connected'));
    this._send(buildAgwFrame({ port, dataKind: 'd', callFrom, callTo }));
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try { this.socket && this.socket.destroy(); } catch (e) { /* ignore */ }
    this.removeAllListeners();
  }
}

module.exports = AgwpeAdapter;
module.exports.buildAgwFrame = buildAgwFrame;
module.exports.HEADER_LEN = HEADER_LEN;
