// KISS framing helpers, ported from NexDigi's server/lib/kiss.js.
//
// Extended (vs. the original) to carry a KISS port number (0-15) in the
// command byte's high nibble, per the KISS spec, instead of hardcoding port
// 0 — this is what lets one serial/TCP KISS TNC multiplex multiple radios.
const FEND = 0xC0;
const FESC = 0xDB;
const TFEND = 0xDC;
const TFESC = 0xDD;
const CMD_DATA = 0x00;

function escapeByte(out, b) {
  if (b === FEND) out.push(FESC, TFEND);
  else if (b === FESC) out.push(FESC, TFESC);
  else out.push(b);
}

function escapeFrame(buf, port = 0) {
  const out = [];
  out.push(FEND);
  // KISS command byte: high nibble = port (0-15), low nibble = command (0 = data).
  // Must be escaped like any other byte — port 12's command byte (0xC0) is
  // otherwise indistinguishable from the FEND delimiter itself.
  escapeByte(out, ((port & 0x0f) << 4) | CMD_DATA);
  for (const b of buf) escapeByte(out, b);
  out.push(FEND);
  return Buffer.from(out);
}

// Returns an array of { port, frame } for each complete frame found between
// FEND delimiters. Non-data KISS commands (SetHardware, TXDelay, etc.) are
// skipped rather than mistaken for data.
function unescapeStream(buf) {
  const results = [];
  let cur = [];
  let inFrame = false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === FEND) {
      if (inFrame && cur.length) {
        let frameBuf = Buffer.from(cur);
        let port = 0;
        if (frameBuf.length > 0) {
          const cmdByte = frameBuf[0];
          const command = cmdByte & 0x0f;
          port = (cmdByte >> 4) & 0x0f;
          if (command === CMD_DATA) {
            frameBuf = frameBuf.slice(1);
            results.push({ port, frame: frameBuf });
          }
          // non-data commands (hardware/txdelay/etc.) are intentionally dropped
        }
      }
      cur = [];
      inFrame = true;
      continue;
    }
    if (!inFrame) continue;
    if (b === FESC) {
      const next = buf[++i];
      if (next === TFEND) cur.push(FEND);
      else if (next === TFESC) cur.push(FESC);
      else cur.push(next);
      continue;
    }
    cur.push(b);
  }
  return results;
}

module.exports = { escapeFrame, unescapeStream, FEND, FESC, TFEND, TFESC };
