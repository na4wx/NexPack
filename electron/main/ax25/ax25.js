// Minimal AX.25 address and path parsing utilities
// This module parses AX.25 address fields from a raw UI frame buffer (KISS payload)
// It expects the buffer to start with the AX.25 header (destination, source, path, control, pid...)


function parseAddressField(buf, offset) {
  // Each AX.25 address field is 7 bytes: 6 for callsign (shifted left by 1), 1 for SSID and flags
  const callsignBytes = [];
  for (let i = 0; i < 6; i++) callsignBytes.push(buf[offset + i]);
  const callsign = Buffer.from(callsignBytes).map(b => b >> 1).toString('ascii').trim();
  const ssidByte = buf[offset + 6];
  const ssid = (ssidByte >> 1) & 0x0F; // nibble
  const hasBeenRepeated = (ssidByte & 0x80) === 0x80; // H-bit (we use bit 7)
  const last = (ssidByte & 0x01) === 0x01; // extension bit (EA) == 1 indicates last address
  return { callsign, ssid, hasBeenRepeated, last, length: 7 };
}

function parseAx25Frame(buf) {
  // parse destination, source, and path until last address byte flag (EA bit)
  let offset = 0;
  const addresses = [];
  while (offset + 7 <= buf.length) {
    const ad = parseAddressField(buf, offset);
    addresses.push({ callsign: ad.callsign, ssid: ad.ssid, marked: ad.hasBeenRepeated });
    offset += 7;
    if (ad.last) break;
  }
  // after addresses: control (1 byte), pid (optional 1), then payload
  const control = buf[offset];
  offset += 1;
  // PID is present for I and UI frames. U/S frames (e.g., SABM/UA/DM/DISC) do not carry a PID.
  let pid;
  const isIFrame = (control & 0x01) === 0x00; // LSB 0
  const isUI    = control === 0x03;
  if (isIFrame || isUI) {
    pid = buf[offset];
    offset += 1;
  } else {
    pid = undefined;
  }
  const payload = buf.slice(offset);
  return { addresses, control, pid, payload, raw: buf };
}

function _callsignBase(callsign) {
  // Normalize callsign base: remove trailing dash or numeric suffix
  // Examples:
  //  - 'WIDE2-2' -> 'WIDE2'
  //  - 'WIDE2-'  -> 'WIDE2' (handle truncated on-wire tokens)
  const s = String(callsign || '').toUpperCase().trim();
  return s.replace(/-(?:\d+)?$/, '');
}

function serviceAddressInBuffer(rawBuf, targetCallBase) {
  // Finds first address whose callsign base equals targetCallBase (case-insensitive).
  // If the address is a WIDE-style with ssid>0 we decrement the ssid nibble.
  // In all cases we set the H-bit (0x80) to mark as digipeated.
  const buf = Buffer.from(rawBuf);
  // If caller provided a target like 'WIDE2-2', capture its numeric suffix to use when on-wire callsign is truncated
  const targetMatch = String(targetCallBase || '').toUpperCase().match(/^(.+)-(\d+)$/);
  const targetSuffix = targetMatch ? Number(targetMatch[2]) : null;

  let offset = 0;
  while (offset + 7 <= buf.length) {
    const callsignBytes = [];
    for (let i = 0; i < 6; i++) callsignBytes.push(buf[offset + i]);
    const cs = Buffer.from(callsignBytes).map(b => b >> 1).toString('ascii').trim();
    const ssidByte = buf[offset + 6];
    const ssid = (ssidByte >> 1) & 0x0F;
    const last = (ssidByte & 0x01) === 0x01;
    if (_callsignBase(cs) === _callsignBase(targetCallBase)) {
      // First: if callsign contains a textual suffix like 'WIDE2-2', decrement that suffix in-place.
      const m = cs.match(/^(.+)-(\d+)$/);
      if (m) {
        const base = m[1];
        const count = Number(m[2]);
        if (!Number.isNaN(count) && count > 0) {
          const newCount = count - 1;
          const newCall = `${base}-${newCount}`;
          // write newCall back into the 6-byte callsign field (truncate or pad)
          const padded = newCall.toUpperCase().padEnd(6, ' ').slice(0, 6);
          for (let i = 0; i < 6; i++) buf[offset + i] = padded.charCodeAt(i) << 1;
          // set H-bit on SSID byte
          buf[offset + 6] = (buf[offset + 6] | 0x80);
          return buf;
        }
        // if count is 0, still set H-bit
        buf[offset + 6] = (buf[offset + 6] | 0x80);
        return buf;
      }

      // If the on-wire callsign was truncated (e.g. 'WIDE2-') but the caller provided a numeric suffix
      // (targetSuffix from targetCallBase like 'WIDE2-2'), use that numeric suffix to decrement the SSID nibble.
      if (targetSuffix !== null) {
        if (targetSuffix > 0) {
          const newSsid = Math.max(0, targetSuffix - 1);
          let newByte = (ssidByte & 0x81) | ((newSsid & 0x0F) << 1);
          newByte = newByte | 0x80;
          buf[offset + 6] = newByte;
        } else {
          buf[offset + 6] = (buf[offset + 6] | 0x80);
        }
        return buf;
      }

      // If callsign begins with WIDE and has a numeric ssid, decrement that numeric hop count
      if (/^WIDE/i.test(cs) && ssid > 0) {
        const newSsid = Math.max(0, ssid - 1);
        // preserve bits except for SSID nibble and H-bit
        let newByte = (ssidByte & 0x81) | ((newSsid & 0x0F) << 1);
        // set H-bit to indicate serviced
        newByte = newByte | 0x80;
        buf[offset + 6] = newByte;
      } else {
        // just set H-bit
        buf[offset + 6] = buf[offset + 6] | 0x80;
      }
      return buf;
    }

    offset += 7;
    if (last) break;
  }
  // no match; return original
  return buf;
}

function formatCallsign(callsign, ssid) {
  // produce 6-byte callsign shifted left by 1
  const cs = callsign.toUpperCase().padEnd(6, ' ');
  const bytes = Buffer.alloc(7);
  for (let i = 0; i < 6; i++) bytes[i] = cs.charCodeAt(i) << 1;
  // SSID byte: bits 1-4 SSID, bit0 EA (set externally), we preserve other bits as zero
  bytes[6] = ((ssid & 0x0F) << 1) & 0xFE;
  return bytes;
}

module.exports = { parseAx25Frame, parseAddressField, formatCallsign, serviceAddressInBuffer, _callsignBase };
 
// Build a minimal AX.25 frame (destination, source, optional path none) with given control/pid/payload
// control: 0x2F SABM, 0x63 UA, 0x43 DISC, 0x0F DM, 0x03 UI, 0x00 I (Ns=0/Nr=0)
function buildAx25Frame(opts) {
  const { dest, src, control = 0x03, pid = 0xF0, payload, commandType } = opts || {};
  if (!dest || !src) throw new Error('buildAx25Frame requires dest and src');
  const parseCall = (call) => {
    const m = String(call || '').toUpperCase().match(/^([A-Z0-9]{1,6})(?:-(\d+))?$/);
    return m ? { base: m[1], ssid: Number(m[2] || '0') } : { base: String(call || '').slice(0,6).toUpperCase(), ssid: 0 };
  };
  const d = parseCall(dest);
  const s = parseCall(src);
  const destAddr = formatCallsign(d.base, d.ssid);
  const srcAddr = formatCallsign(s.base, s.ssid);
  // AX.25 V2.0 Command/Response bit (C) usage simplified:
  // For a Command frame: set C bit (bit7) of destination, clear in source.
  // For a Response frame: clear C bit in destination, set in source.
  // If commandType not provided, leave as default (both cleared).
  if (commandType === 'command') {
    destAddr[6] = destAddr[6] | 0x80;      // set C bit in dest
    srcAddr[6] = srcAddr[6] & ~0x80;       // clear in src
  } else if (commandType === 'response') {
    destAddr[6] = destAddr[6] & ~0x80;     // clear in dest
    srcAddr[6] = srcAddr[6] | 0x80;        // set in src
  }
  // mark EA on last address (source)
  srcAddr[6] = srcAddr[6] | 0x01;
  const controlBuf = Buffer.from([control & 0xFF]);
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  // PID is present for UI and I frames; allow omission for U/S frames by passing pid === null
  if (pid === null || pid === undefined) {
    return Buffer.concat([destAddr, srcAddr, controlBuf, payloadBuf]);
  }
  const pidBuf = Buffer.from([pid & 0xFF]);
  return Buffer.concat([destAddr, srcAddr, controlBuf, pidBuf, payloadBuf]);
}

module.exports.buildAx25Frame = buildAx25Frame;
