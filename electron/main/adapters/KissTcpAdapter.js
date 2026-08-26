const EventEmitter = require('events');
const net = require('net');

// A real KISS-TCP client: connects to a TNC/soundmodem's KISS-over-TCP
// port (e.g. Direwolf, UZ7HO SoundModem in KISS mode) and passes raw bytes
// through unmodified. KISS framing/de-framing happens one layer up in
// TncManager, shared with SerialKissAdapter.
class KissTcpAdapter extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 8001, reconnectMs = 5000 }) {
    super();
    this.host = host;
    this.port = port;
    this.reconnectMs = reconnectMs;
    this.transport = 'kiss-tcp';
    this.isSerial = false;
    this._closed = false;
    this._connect();
  }

  _connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on('connect', () => this.emit('open'));
    this.socket.on('data', (d) => this.emit('data', d));
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => {
      this.emit('close');
      if (!this._closed) {
        this._reconnectTimer = setTimeout(() => this._connect(), this.reconnectMs);
      }
    });
  }

  send(buf) {
    if (!this.socket || this.socket.destroyed) return this.emit('error', new Error('KISS-TCP socket not connected'));
    this.socket.write(buf);
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try { this.socket && this.socket.destroy(); } catch (e) { /* ignore */ }
    this.removeAllListeners();
  }
}

module.exports = KissTcpAdapter;
