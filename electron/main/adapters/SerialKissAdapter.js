const EventEmitter = require('events');

// Ported from NexDigi's server/lib/adapters/serialAdapter.js (SerialKissAdapter),
// unmodified in behavior — wraps the `serialport` npm package, tolerant of
// different export shapes across serialport versions. Emits raw bytes as
// they arrive; KISS framing/de-framing happens one layer up in TncManager
// so the same decode logic is shared across serial and KISS-TCP transports.
let SerialPortModule;
try { SerialPortModule = require('serialport'); } catch (e) { /* optional */ }

class SerialKissAdapter extends EventEmitter {
  constructor({ port, baud = 9600, parity = 'none', dataBits = 8, stopBits = 1, rtscts = false, xon = false, xoff = false }) {
    super();
    this.portPath = port;
    this.baud = baud;
    this._open = false;
    this._writeQueue = [];
    this.transport = 'serial';
    this.isSerial = true;

    if (!SerialPortModule) {
      process.nextTick(() => this.emit('error', new Error('serialport package not installed')));
      return;
    }
    this.opts = { baudRate: this.baud, parity, dataBits, stopBits, rtscts, xon, xoff };

    let SerialPortClass = null;
    if (typeof SerialPortModule === 'function') SerialPortClass = SerialPortModule;
    else if (SerialPortModule && typeof SerialPortModule.SerialPort === 'function') SerialPortClass = SerialPortModule.SerialPort;
    else if (SerialPortModule && typeof SerialPortModule.default === 'function') SerialPortClass = SerialPortModule.default;

    if (!SerialPortClass) {
      const keys = SerialPortModule ? Object.keys(SerialPortModule) : [];
      process.nextTick(() => this.emit('error', new Error('serialport package installed but unrecognized export shape: ' + JSON.stringify(keys))));
      return;
    }

    try {
      try {
        this.port = new SerialPortClass(Object.assign({ path: this.portPath, baudRate: this.baud, autoOpen: true }, this.opts));
      } catch (e) {
        this.port = new SerialPortClass(this.portPath, Object.assign({ baudRate: this.baud, autoOpen: true }, this.opts));
      }
    } catch (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }

    this.port.on('open', () => this._onOpen());
    this.port.on('data', (d) => this.emit('data', d));
    this.port.on('error', (e) => this.emit('error', e));
  }

  send(buf) {
    if (!this.port) return this.emit('error', new Error('serial port not available'));
    if (!this._open) { this._writeQueue.push(buf); return; }
    this.port.write(buf, (err) => { if (err) this.emit('error', err); });
  }

  close() {
    try { if (this.port && this._open && typeof this.port.close === 'function') this.port.close(() => {}); } catch (e) { /* ignore */ }
    this._open = false;
    this._writeQueue = [];
    this.removeAllListeners();
  }

  _onOpen() {
    this._open = true;
    this.emit('open');
    while (this._writeQueue.length) {
      const b = this._writeQueue.shift();
      this.port.write(b, (err) => { if (err) this.emit('error', err); });
    }
  }
}

module.exports = SerialKissAdapter;
