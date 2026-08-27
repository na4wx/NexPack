// YAPP (Yet Another Packet Protocol) binary file transfer — the basic
// (non-YappC, non-resume) variant, verified against the real spec text
// (qsl.net/dl8njy/help/text/yapp.txt) rather than implemented from memory.
// v1 scope: single file per transfer, no resume, no checksum extension —
// matches paKet-era simplicity; a bad/missing ack just times out and aborts.

const NUL = 0x00, SOH = 0x01, STX = 0x02, ETX = 0x03, EOT = 0x04, ENQ = 0x05, ACK = 0x06, NAK = 0x15, CAN = 0x18;
const TIMEOUT_MS = 15000;
const CHUNK_SIZE = 256;

function packet(controlByte, ...rest) { return Buffer.concat([Buffer.from([controlByte]), Buffer.from(rest)]); }

class YappSender {
  constructor({ sendRawFn, filename, data, onProgress, onComplete, onError }) {
    this.sendRawFn = sendRawFn;
    this.filename = filename;
    this.data = data;
    this.onProgress = onProgress || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});
    this.state = 'idle';
    this.offset = 0;
    this._timer = null;
  }

  start() {
    this.state = 'init';
    this._send(packet(ENQ, 0x01));
    this._arm();
  }

  _arm() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._fail('timed out waiting for a reply'), TIMEOUT_MS);
  }

  _send(buf) { this.sendRawFn(buf); }

  _fail(message) {
    clearTimeout(this._timer);
    if (this.state === 'done' || this.state === 'error') return;
    this.state = 'error';
    this.onError(new Error(message));
  }

  abort() {
    if (this.state === 'done' || this.state === 'error') return;
    this._send(packet(CAN, 0x00));
    this._fail('aborted');
  }

  onBytes(chunk) {
    clearTimeout(this._timer);
    const b = chunk;
    if (this.state === 'init') {
      if (b[0] === ACK && b[1] === 0x01) { this._sendHeader(); return; }
      if (b[0] === ACK && b[1] === 0x02) { this._sendData(); return; }
      this._fail('receiver declined the file offer');
      return;
    }
    if (this.state === 'header') {
      if (b[0] === ACK && b[1] === 0x02) { this._sendData(); return; }
      this._fail('receiver rejected the file header');
      return;
    }
    if (this.state === 'eof') {
      if (b[0] === ACK && b[1] === 0x03) { this._sendEot(); return; }
      this._fail('receiver did not acknowledge EOF');
      return;
    }
    if (this.state === 'eot') {
      if (b[0] === ACK && b[1] === 0x04) {
        clearTimeout(this._timer);
        this.state = 'done';
        this.onComplete();
        return;
      }
      this._fail('receiver did not acknowledge EOT');
      return;
    }
    // 'data' state: no reply expected between chunks in the basic (non-YappC) variant.
    this._arm();
  }

  _sendHeader() {
    this.state = 'header';
    const size = String(this.data.length);
    const body = Buffer.from(`${this.filename}\x00${size}\x00`, 'ascii');
    if (body.length > 255) throw new Error('filename too long for a YAPP header');
    this._send(Buffer.concat([Buffer.from([SOH, body.length]), body]));
    this._arm();
  }

  _sendData() {
    this.state = 'data';
    this._sendNextChunk();
  }

  _sendNextChunk() {
    if (this.offset >= this.data.length) { this._sendEof(); return; }
    const chunk = this.data.subarray(this.offset, this.offset + CHUNK_SIZE);
    this.offset += chunk.length;
    const lenByte = chunk.length === 256 ? 0 : chunk.length;
    this._send(Buffer.concat([Buffer.from([STX, lenByte]), chunk]));
    this.onProgress({ bytesTransferred: this.offset, totalBytes: this.data.length });
    this._arm();
    // Basic YAPP is unacknowledged per-chunk; pace sends on a short timer
    // rather than flooding the TNC.
    setTimeout(() => { if (this.state === 'data') this._sendNextChunk(); }, 50);
  }

  _sendEof() {
    this.state = 'eof';
    this._send(packet(ETX, 0x01));
    this._arm();
  }

  _sendEot() {
    this.state = 'eot';
    this._send(packet(EOT, 0x01));
    this._arm();
  }
}

class YappReceiver {
  constructor({ sendRawFn, onOffer, onProgress, onComplete, onError }) {
    this.sendRawFn = sendRawFn;
    this.onOffer = onOffer || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});
    this.state = 'idle';
    this.filename = null;
    this.totalBytes = 0;
    this.chunks = [];
    this.received = 0;
    this._buf = Buffer.alloc(0);
    this._timer = null;
  }

  _send(buf) { this.sendRawFn(buf); }

  _arm() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._fail('timed out waiting for data'), TIMEOUT_MS);
  }

  _fail(message) {
    clearTimeout(this._timer);
    if (this.state === 'done' || this.state === 'error') return;
    this.state = 'error';
    this.onError(new Error(message));
  }

  // Called by the caller once the user has accepted the offer (after onOffer fired with filename/size).
  accept() {
    this.state = 'data';
    this._send(packet(ACK, 0x02));
    this._arm();
  }

  reject() {
    this._send(packet(NAK, 0x00));
    this.state = 'idle';
  }

  abort() {
    if (this.state === 'done' || this.state === 'error') return;
    this._send(packet(CAN, 0x00));
    this._fail('aborted');
  }

  onBytes(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._pump();
  }

  _pump() {
    // Consume as many complete packets as are currently buffered.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._buf.length === 0) return;
      const ctrl = this._buf[0];

      if (this.state === 'idle') {
        if (this._buf.length < 2) return;
        if (ctrl === ENQ) {
          this._buf = this._buf.subarray(2);
          // Per spec, we must ack the init with RR to request the header
          // before we know the filename — the real accept/reject decision
          // point is after the header arrives, not here.
          this.state = 'awaiting-header';
          this._send(packet(ACK, 0x01));
          this._arm();
          continue;
        }
        this._buf = this._buf.subarray(1); // discard stray byte
        continue;
      }

      if (this.state === 'awaiting-header') {
        if (ctrl !== SOH) { this._buf = this._buf.subarray(1); continue; }
        if (this._buf.length < 2) return;
        const len = this._buf[1]; // header length has no 0=256 convention (that's DT-specific)
        if (this._buf.length < 2 + len) return; // wait for the rest
        const body = this._buf.subarray(2, 2 + len).toString('ascii');
        this._buf = this._buf.subarray(2 + len);
        const [filename, sizeStr] = body.split('\x00');
        this.filename = filename;
        this.totalBytes = Number(sizeStr) || 0;
        this.state = 'offer-pending';
        clearTimeout(this._timer);
        this.onOffer({ filename: this.filename, totalBytes: this.totalBytes }); // caller decides accept()/reject()
        continue;
      }

      if (this.state === 'offer-pending') return; // waiting on accept()/reject() from the caller

      if (this.state === 'data') {
        if (ctrl === STX) {
          if (this._buf.length < 2) return;
          const len = this._buf[1] === 0 ? 256 : this._buf[1];
          if (this._buf.length < 2 + len) return;
          const data = Buffer.from(this._buf.subarray(2, 2 + len));
          this._buf = this._buf.subarray(2 + len);
          this.chunks.push(data);
          this.received += data.length;
          this.onProgress({ bytesTransferred: this.received, totalBytes: this.totalBytes });
          this._arm();
          continue;
        }
        if (ctrl === ETX) {
          if (this._buf.length < 2) return;
          this._buf = this._buf.subarray(2);
          this._send(packet(ACK, 0x03));
          this.state = 'awaiting-eot';
          this._arm();
          continue;
        }
        this._buf = this._buf.subarray(1);
        continue;
      }

      if (this.state === 'awaiting-eot') {
        if (ctrl === EOT) {
          if (this._buf.length < 2) return;
          this._buf = this._buf.subarray(2);
          this._send(packet(ACK, 0x04));
          clearTimeout(this._timer);
          this.state = 'done';
          this.onComplete(Buffer.concat(this.chunks));
          return;
        }
        if (ctrl === ENQ) { // another file follows — not supported in v1, treat as done
          clearTimeout(this._timer);
          this.state = 'done';
          this.onComplete(Buffer.concat(this.chunks));
          return;
        }
        this._buf = this._buf.subarray(1);
        continue;
      }

      return;
    }
  }
}

module.exports = { YappSender, YappReceiver };
