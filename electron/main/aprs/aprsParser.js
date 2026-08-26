// APRS payload parsing. Position/weather decoding ported from NexDigi's
// server/lib/backbone/APRSStationTracker.js and WeatherParser.js (both are
// pure string->object functions there, verified to have no backbone-state
// dependency — safe to copy). Mic-E and the APRS-IS TNC2 line format have
// no equivalent anywhere in NexDigi and are built fresh here, directly
// against the official APRS 1.0.1 protocol reference (aprs.org/doc/APRS101.PDF,
// Chapter 10 for Mic-E) rather than from memory, given how easy it is to
// get Mic-E's bit-packed encoding subtly wrong.

function parseAPRSCoord(coord) {
  const match = coord.match(/(\d{2,5})\.(\d{2})([NSEW])/);
  if (!match) return null;
  const [, degrees, minutes, dir] = match;
  const isLat = dir === 'N' || dir === 'S';
  const degInt = parseInt(isLat ? degrees.slice(0, 2) : degrees.slice(0, 3));
  const minInt = parseInt(isLat ? degrees.slice(2) : degrees.slice(3));
  const minFrac = parseInt(minutes);
  let decimal = degInt + (minInt + minFrac / 100) / 60;
  if (dir === 'S' || dir === 'W') decimal = -decimal;
  return decimal;
}

function decodeCompressedPosition(latComp, lonComp, csT) {
  const base91ToNum = (str) => {
    let num = 0;
    for (let i = 0; i < str.length; i++) num = num * 91 + (str.charCodeAt(i) - 33);
    return num;
  };
  const latVal = base91ToNum(latComp);
  const lonVal = base91ToNum(lonComp);
  const latitude = 90 - latVal / 380926;
  const longitude = -180 + lonVal / 190463;
  const cs = base91ToNum(csT);
  const course = Math.floor(cs / 91);
  const speed = (cs % 91) - 1;
  const result = { latitude, longitude };
  if (course >= 0 && course <= 360) result.course = course * 4;
  if (speed >= 0) result.speed = Math.pow(1.08, speed) - 1; // knots
  return result;
}

// payload: the AX.25 UI frame's ASCII payload/content string.
function parsePosition(payload) {
  const content = payload || '';

  const uncompressedMatch = content.match(/[!=@/](\d{4}\.\d{2}[NS])[/\\](\d{5}\.\d{2}[EW])(.)(.)/);
  if (uncompressedMatch) {
    const [, latStr, lonStr, symbolTable, symbolCode] = uncompressedMatch;
    return { latitude: parseAPRSCoord(latStr), longitude: parseAPRSCoord(lonStr), symbol: symbolTable + symbolCode, format: 'uncompressed' };
  }

  const compressedMatch = content.match(/[!=@/]([\x21-\x7B]{4})([\x21-\x7B]{4})(.)(.)([\x21-\x7B]{2})/);
  if (compressedMatch) {
    const [, latComp, lonComp, symbolTable, symbolCode, csT] = compressedMatch;
    try {
      const position = decodeCompressedPosition(latComp, lonComp, csT);
      position.symbol = symbolTable + symbolCode;
      position.format = 'compressed';
      return position;
    } catch (e) { /* fall through */ }
  }

  return null;
}

function parseWeather(payload) {
  const content = payload || '';
  const hasWeatherData =
    content.match(/_(\d{3})\/(\d{3})g(\d{3})t([+-]?\d{3})/) ||
    content.match(/g(\d{3})t([+-]?\d{3})r(\d{3})p(\d{3})/) ||
    content.match(/t([+-]?\d{3})h(\d{2})/);
  if (!hasWeatherData) return null;

  const weather = { type: 'aprs_weather' };
  const windMatch = content.match(/_(\d{3})\/(\d{3})g(\d{3})/);
  if (windMatch) { weather.windDirection = parseInt(windMatch[1]); weather.windSpeed = parseInt(windMatch[2]); weather.windGust = parseInt(windMatch[3]); }
  const tempMatch = content.match(/t([+-]?\d{3})/);
  if (tempMatch) weather.temperature = parseInt(tempMatch[1]);
  const rainMatch = content.match(/r(\d{3})/);
  if (rainMatch) weather.rainfall1h = parseInt(rainMatch[1]) / 100;
  const rain24Match = content.match(/p(\d{3})/);
  if (rain24Match) weather.rainfall24h = parseInt(rain24Match[1]) / 100;
  const humidityMatch = content.match(/h(\d{2})/);
  if (humidityMatch) { weather.humidity = parseInt(humidityMatch[1]); if (weather.humidity === 0) weather.humidity = 100; }
  const pressureMatch = content.match(/b(\d{5})/);
  if (pressureMatch) weather.pressure = parseInt(pressureMatch[1]) / 10;
  const posMatch = content.match(/(!|=|@)(\d{4}\.\d{2}[NS])\/(\d{5}\.\d{2}[EW])/);
  if (posMatch) { weather.latitude = parseAPRSCoord(posMatch[2]); weather.longitude = parseAPRSCoord(posMatch[3]); }
  return weather;
}

// ---- Mic-E (APRS101.PDF Chapter 10) ----

const MICE_DTI = new Set(['`', "'", '\x1c', '\x1d']);

// Destination-address char -> { digit: 0-9|null(space/ambiguous), bit }.
// `bit` doubles as message-bit A/B/C (bytes 1-3), N/S (byte 4, 0=South/1=North),
// longitude-offset (byte 5, 0=+0/1=+100), W/E (byte 6, 0=East/1=West) — the
// spec table is one lookup reused with position-dependent meaning.
// `range` distinguishes 'std' (P-Z) vs 'custom' (A-K) vs 'zero' (0-9,L) for
// message-type classification.
const MICE_DEST_TABLE = {};
for (let d = 0; d <= 9; d++) MICE_DEST_TABLE[String(d)] = { digit: d, bit: 0, range: 'zero' };
for (let i = 0; i < 10; i++) MICE_DEST_TABLE[String.fromCharCode(65 + i)] = { digit: i, bit: 1, range: 'custom' }; // A-J -> 0-9
MICE_DEST_TABLE['K'] = { digit: null, bit: 1, range: 'custom' };
MICE_DEST_TABLE['L'] = { digit: null, bit: 0, range: 'zero' };
for (let i = 0; i < 10; i++) MICE_DEST_TABLE[String.fromCharCode(80 + i)] = { digit: i, bit: 1, range: 'std' }; // P-Y -> 0-9
MICE_DEST_TABLE['Z'] = { digit: null, bit: 1, range: 'std' };

const MICE_MESSAGE_TYPES = {
  '111': { std: 'M0: Off Duty', custom: 'C0: Custom-0' },
  '110': { std: 'M1: En Route', custom: 'C1: Custom-1' },
  '101': { std: 'M2: In Service', custom: 'C2: Custom-2' },
  '100': { std: 'M3: Returning', custom: 'C3: Custom-3' },
  '011': { std: 'M4: Committed', custom: 'C4: Custom-4' },
  '010': { std: 'M5: Special', custom: 'C5: Custom-5' },
  '001': { std: 'M6: Priority', custom: 'C6: Custom-6' },
  '000': { std: 'Emergency', custom: 'Emergency' }
};

// destBytes: the 6 raw destination-callsign bytes, ALREADY shifted right 1
// (i.e. plain ASCII, not AX.25's left-shifted form) and NOT trimmed — pass
// ax25Frame.slice(0,6) through `Buffer.from(buf).map(b => b >> 1)`, never
// the already-trimmed `addresses[0].callsign` from ax25.js's parseAx25Frame,
// since trim() would corrupt the K/L/Z "ambiguous digit" space encoding.
// payload: the AX.25 payload starting at the Mic-E Data Type Identifier byte.
function decodeMicE(destBytes, payload) {
  if (!destBytes || destBytes.length < 6 || !payload || payload.length < 9) return null;
  if (!MICE_DTI.has(payload[0])) return null;

  const destChars = [];
  for (let i = 0; i < 6; i++) destChars.push(String.fromCharCode(destBytes[i]));
  const rows = destChars.map((c) => MICE_DEST_TABLE[c]);
  if (rows.some((r) => !r)) return null; // not valid Mic-E destination encoding

  // Latitude digits + ambiguity (a null digit = ambiguous, treated as 0 for
  // the purpose of computing a value; full ambiguity-radius reporting is
  // out of scope here, we just need a valid best-effort position).
  const latDigits = rows.map((r) => (r.digit === null ? 0 : r.digit));
  const latDeg = latDigits[0] * 10 + latDigits[1];
  const latMin = latDigits[2] * 10 + latDigits[3];
  const latMinFrac = latDigits[4] * 10 + latDigits[5];
  const north = rows[3].bit === 1; // byte 4: N/S
  const longOffset = rows[4].bit === 1 ? 100 : 0; // byte 5
  const west = rows[5].bit === 1; // byte 6: W/E
  let latitude = latDeg + (latMin + latMinFrac / 100) / 60;
  if (!north) latitude = -latitude;

  // Message type (bytes 1-3 -> bits A/B/C)
  const bitsStr = `${rows[0].bit}${rows[1].bit}${rows[2].bit}`;
  const ranges = new Set([rows[0].range, rows[1].range, rows[2].range].filter((r) => r !== 'zero'));
  let messageType;
  if (ranges.size > 1) messageType = 'unknown';
  else if (bitsStr === '000') messageType = 'Emergency';
  else messageType = MICE_MESSAGE_TYPES[bitsStr] ? (ranges.has('custom') ? MICE_MESSAGE_TYPES[bitsStr].custom : MICE_MESSAGE_TYPES[bitsStr].std) : 'unknown';

  // Information field (payload bytes 1-8, 0-indexed after the DTI byte 0):
  // d+28, m+28, h+28, SP+28, DC+28, SE+28, symbolCode, symbolTableId
  const b = (i) => payload.charCodeAt(i);
  let d = b(1) - 28;
  if (longOffset === 100) d += 100;
  if (d >= 180 && d <= 189) d -= 80;
  else if (d >= 190 && d <= 199) d -= 190;
  let m = b(2) - 28;
  if (m >= 60) m -= 60;
  const h = b(3) - 28;
  let longitude = d + (m + h / 100) / 60;
  if (west) longitude = -longitude;

  // SP+28 and DC+28 each have two valid encoding schemes in the wild
  // (legacy vs modern Mic-E encoders) that must be normalized before use —
  // derived and verified against the full official tables and the spec's
  // worked example (which decodes to course=251, speed=20kt exactly):
  // SP+28: raw = byte-28; values >=80 are the legacy scheme, offset by 80.
  let spRaw = b(4) - 28;
  if (spRaw >= 80) spRaw -= 80;
  const sp = spRaw * 10;
  // DC+28: raw = byte-28 = units*10 + courseHundredsIndex(0-3) in the
  // modern scheme, or that value +4 in the legacy scheme — the two never
  // collide since courseHundredsIndex only spans 0-3 (mod10 0-3 vs 4-7).
  let dcRaw = b(5) - 28;
  const dcMod = ((dcRaw % 10) + 10) % 10;
  if (dcMod >= 4 && dcMod <= 7) dcRaw -= 4;
  const speedUnits = Math.floor(dcRaw / 10);
  let courseHundreds = dcRaw % 10;
  let speed = sp + speedUnits;
  if (speed >= 800) speed -= 800;
  let se = b(6) - 28;
  let course = courseHundreds * 100 + se;
  if (course >= 400) course -= 400;

  const symbolCode = payload[7];
  const symbolTable = payload[8];

  return {
    latitude, longitude,
    symbol: symbolTable + symbolCode,
    format: 'mic-e',
    course, speed, // knots
    messageType,
    status: payload.length > 9 ? payload.slice(9) : ''
  };
}

// ---- APRS-IS TNC2 line format: "FROM>TO,PATH1,PATH2:payload" ----
function parseTnc2Line(line) {
  const trimmed = (line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null; // comment/server banner
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return null;
  const header = trimmed.slice(0, colonIdx);
  const payload = trimmed.slice(colonIdx + 1);
  const gtIdx = header.indexOf('>');
  if (gtIdx === -1) return null;
  const from = header.slice(0, gtIdx);
  const rest = header.slice(gtIdx + 1).split(',');
  const to = rest[0];
  const path = rest.slice(1);
  return { from, to, path, payload };
}

module.exports = { parseAPRSCoord, decodeCompressedPosition, parsePosition, parseWeather, decodeMicE, parseTnc2Line };
