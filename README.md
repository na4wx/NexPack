# NexPack

**A next-generation packet radio, Winlink, and APRS client for the desktop.**

> ⚠️ **Alpha software — currently v0.3.2.** Actively developed and tested against real RF hardware, but expect rough edges, incomplete parsing of edge cases, and breaking changes between versions. Not yet recommended for anything you depend on.

A standalone companion app for [NexDigi](https://github.com/na4wx/NexDigi), covering multi-TNC/multi-radio packet terminal, Winlink mail, BBS and real-time chat over RF, a full APRS client, and an optional built-in sound-card TNC in one place.

Built with Electron + React + MUI. All TNC/radio I/O (serial, KISS-TCP, AGWPE, built-in sound modem) runs in the Electron main process; the renderer talks to it over IPC only.

## Downloads

Prebuilt installers are on the [Releases page](https://github.com/na4wx/NexPack/releases):

- **macOS** — `.dmg` (Apple Silicon)
- **Linux** — `.deb` (amd64 and arm64)
- **Windows** — `.msi`

## Features

- **Terminal** — connected-mode AX.25 sessions over serial KISS, KISS-TCP, real AGWPE, or the built-in sound-card modem, with multi-TNC/multi-radio support. Also supports digipeater paths (up to 8 hops), YAPP binary file transfer, per-session logging to disk, and saved connect scripts (e.g. automated BBS login handshakes). Terminal, BBS, and Chat can each be given their own callsign-SSID that accepts *incoming* RF connections — a remote station connecting to Terminal's identity gets an editable preamble and a "reply CHAT or BBS" menu; connecting directly to BBS's or Chat's own identity skips the menu entirely. Verified for real AX.25 2.0/2.2 compliance directly against the TAPR/ARRL spec, address-field bits and command/response framing included.
- **Winlink** — native B2F client (via a bundled [`pat`](https://github.com/la5nta/pat) subprocess) over Telnet or RF, with your own Winlink account — messages live on your station, not on NexDigi. Connecting over RF picks one of your already-configured radios (an AGWPE TNC, or the built-in Sound Modem) rather than a raw host/port, and the RMS Gateway to connect to is a searchable, freely-editable autocomplete backed by `pat`'s real live-downloaded gateway directory — entered at connect time, not pinned in Settings.
- **BBS** — read, post, and delete NexDigi BBS mail directly over RF from a remote station connecting into NexPack, driving the digipeater's real AX.25 connected-mode BBS protocol with no internet required; configured under the NexChat settings tab, since RF NexChat rides the same BBS session.
- **NexChat** — real-time chat against NexDigi's own chat system (not standard AX.25 packet chat), over the internet (REST + WebSocket) **or over RF** — a toggle switches NexChat onto the same AX.25 BBS connection RF BBS uses, driving the digipeater's real keyboard-to-keyboard chat protocol (rooms, `/join`, `/msg`, `/list`, `/users`, ...) with no internet required.
- **APRS** — a full client, not just a viewer: RF monitoring (always on, no APRS-IS required) plus optional APRS-IS, beaconing (with a default beacon text of `NexPack v.<version>`, editable in settings), messaging (with ack/retry, a "heard direct" vs. "heard via digipeater" indicator per message, and automatic dedup of the same message arriving more than once), station detail (distance/bearing, packet log, weather, telemetry), objects/items, and a Leaflet map with custom station icons and hover-to-see-callsign tooltips.
  - The map's home-position circle is a real **footprint indicator**, not a fixed radius — it grows to the farthest station you've ever actually heard *direct* (no digipeater in the path), and stations heard direct get a green ring on their marker so you can see what's establishing that radius at a glance.
  - Messages and a live Packet Monitor can each be opened as a floating window or docked to the right of the map (stacking vertically, with a drag-to-resize divider, when both are docked); the station list, station detail panel, and docked panels are all drag-to-resize with widths remembered across restarts.
- **Built-in Sound Modem** *(experimental)* — a new TNC type that runs [Direwolf](https://github.com/wb2osz/direwolf) against a USB/Bluetooth-paired sound card directly, no external TNC hardware or software required. NexPack builds and bundles its own Direwolf binaries for macOS, Linux, and Windows (see [Credits](#credits)) with real audio-device dropdowns populated from the actual device list. PTT via VOX, CM108 GPIO, or serial RTS/DTR. Also opens a real AGWPE port alongside its KISS port, so it can be picked as a Winlink RF radio too.
- **Update checker** — Settings → About has a "Check for updates" button, and the app checks once on launch, against the project's GitHub Releases.

## Supported TNC connections

- **Serial (KISS)** — any TNC/soundmodem exposing a KISS interface over a serial port.
- **KISS over TCP** — e.g. Direwolf, UZ7HO SoundModem in KISS-TCP mode.
- **AGWPE** — real AGWPE binary protocol (login, port info, raw-frame send/receive), for AGWPE-native servers and multi-port TNCs.
- **Built-in Sound Modem** *(experimental)* — NexPack's own bundled Direwolf, driving a USB/Bluetooth sound card directly with no external TNC software needed.

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
- **[Direwolf](https://github.com/wb2osz/direwolf)** by John Langner (WB2OSZ) and contributors — the AFSK/9600 software modem behind the built-in Sound Modem TNC type. Licensed GPL-2.0-or-later; since no portable official binary exists for every platform NexPack ships, NexPack builds its own from source per-platform (see `scripts/build-direwolf/`) and runs it as an unmodified subprocess over its own KISS-TCP port (mere aggregation) — NexPack's own code stays MIT. See Direwolf's own [LICENSE](https://github.com/wb2osz/direwolf/blob/master/LICENSE).
- **[Leaflet](https://leafletjs.com/)** (BSD-2-Clause) — the mapping library behind the APRS map.
- **[OpenStreetMap](https://www.openstreetmap.org/copyright)** contributors — map tile data shown on the APRS map, © OpenStreetMap contributors, ODbL.
- **[NexDigi](https://github.com/na4wx/NexDigi)** — the digipeater server this app is a companion to.
