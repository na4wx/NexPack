// Small original custom APRS station icon set (~25 icons + a colored-dot
// fallback for everything else). Built from scratch rather than bundling a
// third-party symbol set: the complete official ~240-icon table (used by
// aprs.fi) has an "Unknown" license on most symbols plus actual embedded
// corporate trademarks (Apple/Microsoft/Kenwood logos) baked in — not safe
// to bundle in an installer. The only cleanly-licensed alternative (CC BY
// 4.0) is explicitly incomplete. This set is deliberately small and 100%
// original artwork, so there's nothing to attribute or worry about.
//
// Symbol-code -> meaning mapping is real, taken directly from the official
// APRS 1.0.1 spec's Appendix 2 (aprs.org/doc/APRS101.PDF) — only the
// GRAPHICS are original, not the code assignments themselves (those are
// simply facts about the protocol, not copyrightable).
//
// Exports plain SVG markup strings (not React components) since Leaflet's
// L.divIcon takes raw HTML, not JSX.

const CATEGORY_COLOR = {
  vehicle: '#5b9bff',
  weather: '#00c9a7',
  emergency: '#f85149',
  structure: '#d29922',
  aircraft: '#a371f7',
  marine: '#39a0ed',
  living: '#3fb950',
  infra: '#9aa7b5'
};

// Each entry: glyph is the INNER svg markup (drawn in a 0-24 viewBox,
// centered), category picks the badge color.
const GLYPHS = {
  '/>': { category: 'vehicle', glyph: '<rect x="4" y="10" width="16" height="6" rx="1.5"/><path d="M6 10 L8 6 H16 L18 10 Z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>' }, // Car
  '/<': { category: 'vehicle', glyph: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17 L11 10 H16 L18 17 M11 10 L9 6"/>' }, // Motorcycle
  '/k': { category: 'vehicle', glyph: '<rect x="3" y="9" width="10" height="7" rx="1"/><path d="M13 12 H18 L20 15 V16 H13 Z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>' }, // Truck
  '/u': { category: 'vehicle', glyph: '<rect x="2" y="10" width="8" height="6" rx="1"/><rect x="11" y="8" width="9" height="8" rx="1"/><circle cx="6" cy="18" r="2"/><circle cx="16" cy="18" r="2"/>' }, // 18-wheeler
  '/v': { category: 'vehicle', glyph: '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M3 12 H19"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>' }, // Van
  '/j': { category: 'vehicle', glyph: '<rect x="4" y="9" width="14" height="6" rx="1"/><path d="M4 9 V6 H18 V9"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>' }, // Jeep
  '/b': { category: 'vehicle', glyph: '<circle cx="6" cy="17" r="3.5" fill="none" stroke-width="1.6"/><circle cx="18" cy="17" r="3.5" fill="none" stroke-width="1.6"/><path d="M6 17 L11 8 H15 M11 8 L18 17 M9 12 H14" fill="none" stroke-width="1.6"/>' }, // Bicycle
  '/a': { category: 'emergency', glyph: '<rect x="3" y="9" width="14" height="7" rx="1"/><path d="M17 11 H21 L22 14 V16 H17 Z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 12.5 H12 M10 10.5 V14.5" stroke="#fff" stroke-width="1.3"/>' }, // Ambulance
  '/f': { category: 'emergency', glyph: '<rect x="3" y="8" width="12" height="7" rx="1"/><path d="M15 10 H19 L21 13 V15 H15 Z"/><circle cx="7" cy="17" r="2"/><circle cx="18" cy="17" r="2"/><path d="M6 8 L6 5 M9 8 L9 4" stroke-width="1.4"/>' }, // Fire truck
  '/s': { category: 'marine', glyph: '<path d="M4 15 Q12 20 20 15 L18 12 H6 Z"/><path d="M12 12 V5 L17 12 Z"/>' }, // Ship/power boat
  '/Y': { category: 'marine', glyph: '<path d="M5 16 Q12 19 19 16 L17 14 H7 Z"/><path d="M12 14 V4 L18 14 Z" fill="none" stroke-width="1.4"/>' }, // Yacht/sailboat
  '/O': { category: 'aircraft', glyph: '<circle cx="12" cy="9" r="6"/><path d="M9 15 L8 19 H16 L15 15" fill="none" stroke-width="1.4"/>' }, // Balloon
  '/^': { category: 'aircraft', glyph: '<path d="M12 3 L14 10 L21 13 L14 14 L15 20 L12 18 L9 20 L10 14 L3 13 L10 10 Z"/>' }, // Large aircraft
  '/g': { category: 'aircraft', glyph: '<path d="M12 5 L13 11 L22 12 L13 13 L12 19 L11 13 L2 12 L11 11 Z" fill="none" stroke-width="1.3"/>' }, // Glider
  '/X': { category: 'aircraft', glyph: '<rect x="9" y="10" width="6" height="8" rx="1.5"/><path d="M2 8 H22 M12 8 V4" stroke-width="1.6"/><circle cx="12" cy="18" r="1.5"/>' }, // Helicopter
  '/-': { category: 'structure', glyph: '<path d="M4 12 L12 5 L20 12 V19 H4 Z"/><rect x="10" y="13" width="4" height="6" fill="#0d1117"/>' }, // House QTH
  '/#': { category: 'infra', glyph: '<path d="M12 3 L20 12 L12 21 L4 12 Z" fill="none" stroke-width="1.6"/><path d="M12 3 L20 12 L12 21 L4 12 Z" transform="scale(0.55) translate(9.8,9.8)"/>' }, // Digi
  '/_': { category: 'weather', glyph: '<path d="M7 14 a5 5 0 1 1 1 -9.9 A6 6 0 1 1 17 14 Z"/><path d="M8 17 V20 M12 17 V21 M16 17 V20" stroke="#fff" stroke-width="1.4"/>' }, // Weather station
  '/r': { category: 'infra', glyph: '<path d="M12 3 V21 M6 9 a6 6 0 0 1 12 0 M4 13 a8 8 0 0 1 16 0" fill="none" stroke-width="1.4"/>' }, // Antenna
  '/W': { category: 'weather', glyph: '<path d="M7 15 a5 5 0 1 1 1 -9.8 A6 6 0 1 1 17 15 Z"/>' }, // NWS site
  '/h': { category: 'structure', glyph: '<rect x="4" y="7" width="16" height="13" rx="1"/><path d="M9 11 H15 M12 8 V14" stroke="#fff" stroke-width="1.8"/>' }, // Hospital
  '/P': { category: 'infra', glyph: '<path d="M12 3 L19 6 V12 C19 17 16 20 12 21 C8 20 5 17 5 12 V6 Z"/>' }, // Police (shield)
  '/;': { category: 'living', glyph: '<path d="M4 19 L12 6 L20 19 Z" fill="none" stroke-width="1.6"/><path d="M12 6 V19" stroke-width="1.2"/>' }, // Campground
  '/e': { category: 'living', glyph: '<path d="M6 18 L7 11 Q8 6 13 6 Q17 6 17 10 L15 12 L17 13 L14 14 L14 18" fill="none" stroke-width="1.5"/>' }, // Horse
  '/[': { category: 'living', glyph: '<circle cx="13" cy="5" r="2"/><path d="M13 7 L10 13 L6 15 M13 7 L16 12 L20 11 M10 13 L11 19 M13 12 L14 19" fill="none" stroke-width="1.6"/>' }, // Jogger
  '\\!': { category: 'emergency', glyph: '<path d="M12 3 L21 20 H3 Z"/><path d="M12 9 V14 M12 16.5 V17" stroke="#0d1117" stroke-width="1.8"/>' } // Emergency (alternate table)
};

const DEFAULT_DOT_COLOR = '#5b9bff';

function badge(colorHex, innerSvg) {
  return `<svg width="28" height="28" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="11" fill="${colorHex}" stroke="#0d1117" stroke-width="1.5"/>
    <g fill="#0d1117" stroke="#0d1117" stroke-linecap="round" stroke-linejoin="round">${innerSvg}</g>
  </svg>`;
}

// Returns an HTML/SVG string suitable for Leaflet's L.divIcon({ html }).
function getStationIconHtml(symbol) {
  const entry = symbol && GLYPHS[symbol];
  if (entry) return badge(CATEGORY_COLOR[entry.category], entry.glyph);
  return `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="7" fill="${DEFAULT_DOT_COLOR}" stroke="#0d1117" stroke-width="1.5"/></svg>`;
}

export { getStationIconHtml, GLYPHS };
