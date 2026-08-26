# NexPack

A standalone desktop companion app for [NexDigi](https://github.com/na4wx/NexDigi) — a multi-TNC, multi-radio packet terminal, with Winlink+BBS mail, Chat, and APRS sections planned.

Built with Electron + React + MUI. All TNC/radio I/O (serial, KISS-TCP, AGWPE) runs in the Electron main process; the renderer talks to it over IPC only.

## Status

**Milestone 1 (in progress): Terminal + multi-TNC/multi-radio.** Winlink/BBS, Chat, and APRS come after that's solid — see the connected NexDigi server's REST/WS APIs, which those milestones will build against.

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

Runs the full test suite: a pure KISS-framing unit test, plus three end-to-end tests that exercise the real adapters (KISS-TCP over a real TCP loopback bridge, serial over a hardware-free `SerialPortMock` null-modem simulation, and AGWPE against a minimal fake AGWPE server) — not mocks that bypass the code under test.

## Packaging

```bash
npm run build:win    # MSI
npm run build:mac    # dmg
npm run build:linux  # deb
```

Uses `electron-builder`; output lands in `release/`.
