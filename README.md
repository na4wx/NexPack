# NexPack

**A next-generation packet radio, Winlink, and APRS client for the desktop.**

A standalone companion app for [NexDigi](https://github.com/na4wx/NexDigi), covering multi-TNC/multi-radio packet terminal, Winlink + BBS mail, real-time chat, and a full APRS client in one place.

Built with Electron + React + MUI. All TNC/radio I/O (serial, KISS-TCP, AGWPE) runs in the Electron main process; the renderer talks to it over IPC only.

## Downloads

Prebuilt installers are on the [Releases page](https://github.com/na4wx/NexPack/releases):

- **macOS** — `.dmg` (Apple Silicon)
- **Linux** — `.deb` (amd64 and arm64)
- **Windows** — `.msi`

## Features

- **Terminal** — connected-mode AX.25 sessions over serial KISS, KISS-TCP, or real AGWPE, with multi-TNC/multi-radio support. Also supports digipeater paths (up to 8 hops), YAPP binary file transfer, per-session logging to disk, and saved connect scripts (e.g. automated BBS login handshakes).
- **Winlink** — native B2F client (via a bundled [`pat`](https://github.com/la5nta/pat) subprocess) over RF (RMS Gateway) or Telnet, with your own Winlink account — messages live on your station, not on NexDigi.
- **BBS** — read/post/delete NexDigi BBS mail either over the internet (NexDigi's REST API) or directly over RF, driving the digipeater's real AX.25 connected-mode BBS protocol with no internet required.
- **Chat** — real-time chat against NexDigi's own chat protocol (REST + WebSocket).
- **APRS** — a full client, not just a viewer: RF monitoring (always on, no APRS-IS required) plus optional APRS-IS, beaconing, messaging (with ack/retry), station detail (distance/bearing, packet log, weather, telemetry), objects/items, and a Leaflet map with custom station icons.

## Supported TNC connections

- **Serial (KISS)** — any TNC/soundmodem exposing a KISS interface over a serial port.
- **KISS over TCP** — e.g. Direwolf, UZ7HO SoundModem in KISS-TCP mode.
- **AGWPE** — real AGWPE binary protocol (login, port info, raw-frame send/receive), for AGWPE-native servers and multi-port TNCs.

A single KISS TNC (serial or TCP) can host multiple radios via the KISS port nibble (0–15) if the hardware multiplexes them; AGWPE TNCs natively expose multiple radio ports over one connection.

## Development

```bash
npm install
npm run dev
```

This runs the Vite dev server for the renderer and Electron in development mode together.

## Testing

```bash
npm test
```

Runs the full test suite — real end-to-end tests against the actual adapters and protocol code (KISS-TCP/serial/AGWPE loopbacks, real two-station AX.25 sessions, a real live NexDigi `BBSSessionManager` integration when the sibling [NexDigi](https://github.com/na4wx/NexDigi) repo is checked out alongside this one), not mocks that bypass the code under test.

## Packaging

```bash
npm run build:mac    # dmg
npm run build:linux  # deb
npm run build:win    # msi
```

Uses `electron-builder`; output lands in `release/`.

`build:win` needs Wine to cross-build on macOS/Linux, and Wine's `rcedit` step is currently broken on Apple Silicon hosts (a documented Wine/host-page-size incompatibility, not fixable by retrying) — build the MSI from an actual Windows machine, or from CI on a `windows-latest` runner.

`build:linux` cross-builds cleanly from macOS via Docker (`electronuserland/builder:wine`), but must run against a native Linux filesystem (a Docker volume), not a bind-mounted macOS directory — node-gyp's native module rebuild fails over the bind mount.

## Credits

- **[pat](https://github.com/la5nta/pat)** by Martin Hebnes Pedersen (LA5NTA) and contributors — the Winlink B2F client that powers the Winlink section. Licensed GPL-3.0; NexPack bundles it as an unmodified subprocess and drives it entirely through its local HTTP API (mere aggregation, per GPL-3.0 §5) — NexPack's own code stays MIT. See pat's own [LICENSE](https://github.com/la5nta/pat/blob/master/LICENSE).
- **[Leaflet](https://leafletjs.com/)** (BSD-2-Clause) — the mapping library behind the APRS map.
- **[OpenStreetMap](https://www.openstreetmap.org/copyright)** contributors — map tile data shown on the APRS map, © OpenStreetMap contributors, ODbL.
- **[NexDigi](https://github.com/na4wx/NexDigi)** — the digipeater server this app is a companion to.
