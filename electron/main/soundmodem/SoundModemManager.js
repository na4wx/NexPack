const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');

// Manages one Direwolf (github.com/wb2osz/direwolf, GPL-2.0-or-later)
// subprocess per sound-modem TNC. Direwolf is a real, mature AFSK1200/9600
// software modem — writing a DSP demodulator from scratch would be a
// separate, much larger project with a real risk of being worse than the
// 15+ years of on-air tuning already in Direwolf. Running it as a
// subprocess and talking to it over its own KISS-TCP port is "mere
// aggregation" under the GPL, same reasoning already used for `pat`
// (see PatManager.js) — Direwolf stays GPL-2.0 under its own bundled
// license, NexPack's own code stays MIT.
//
// Unlike `pat`, Direwolf has no official prebuilt binary for every platform
// this app ships (only Windows gets one from upstream; macOS is a Homebrew
// bottle dynamically linked against Homebrew-installed libs; Linux is
// distro packages only) — so instead of repackaging those, NexPack builds
// its own Direwolf binaries from source per-platform (see
// scripts/build-direwolf/*.sh) and vendors them under the repo's own
// direwolf/<platform>[/<arch>]/ directories, matching PatManager's bundling
// shape. macOS's build also vendors its two real dependencies (portaudio,
// hidapi) as self-contained .dylibs in a sibling libs/ folder next to the
// binary (via dylibbundler, with load paths rewritten to
// @executable_path/libs/) so it doesn't need Homebrew present at runtime;
// Linux links dynamically against ALSA/udev, which are effectively
// universal on Debian/Ubuntu desktops; Windows is statically linked against
// the MinGW runtime, so it ships as one .exe with no companion DLLs.
// `NEXPACK_DIREWOLF_PATH` or a system PATH `direwolf` are still honored as
// a fallback for dev machines / platforms this hasn't been built for yet.
class SoundModemManager extends EventEmitter {
  constructor({ userDataDir, resourcesPath }) {
    super();
    // NOT userDataDir: Direwolf's own `-c` argument is copied into a fixed
    // 100-byte buffer (`char config_file[100]` in its direwolf.c) and
    // silently TRUNCATED past that with no error — found running the real
    // bundled binary in a test whose temp dir happened to be long enough to
    // trigger it. A userDataDir-based path (a long macOS "~/Library/
    // Application Support/NexPack/soundmodem/" prefix plus a 36-char UUID
    // tncId) can realistically exceed 100 bytes too. These config files are
    // regenerated fresh on every startFor() call anyway — nothing depends
    // on them surviving a restart — so the OS temp dir (always short) plus
    // a short hash instead of the raw UUID keeps every generated path
    // safely under Direwolf's limit.
    this.dataDir = path.join(os.tmpdir(), 'nexpack-dw');
    this.resourcesPath = resourcesPath;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.instances = new Map(); // tncId -> { proc, port, confPath }
    this._probeCache = new Map(); // bin path -> resolved {input, output} (only ever changes if the OS's default device changes, which needs a relaunch of NexPack anyway)
    this._deviceListCache = null; // { bin, result } — see listAudioDevices()
  }

  _confPathFor(tncId) {
    return path.join(this.dataDir, `${crypto.createHash('sha1').update(tncId).digest('hex').slice(0, 12)}.conf`);
  }

  _resolveBinaryPath() {
    if (process.env.NEXPACK_DIREWOLF_PATH) return process.env.NEXPACK_DIREWOLF_PATH;
    if (this.resourcesPath) {
      // win32 ships one flat binary (only one upstream target exists);
      // darwin/linux are split by process.arch since both have real
      // per-arch builds (or will, as more are added).
      const bundled = process.platform === 'win32'
        ? path.join(this.resourcesPath, 'direwolf', 'win32', 'direwolf.exe')
        : path.join(this.resourcesPath, 'direwolf', process.platform, process.arch, 'direwolf');
      if (fs.existsSync(bundled)) return bundled;
    }
    return process.platform === 'win32' ? 'direwolf.exe' : 'direwolf';
  }

  isRunning(tncId) {
    return this.instances.has(tncId);
  }

  // config: { audioInputDevice, audioOutputDevice, pttMethod ('vox'|'cm108'|'rts'|'dtr'|'none'), pttDevice, callsign }
  async startFor(tncId, config) {
    if (this.instances.has(tncId)) {
      const existing = this.instances.get(tncId);
      return { port: existing.port, agwPort: existing.agwPort };
    }

    const bin = this._resolveBinaryPath();
    let effectiveConfig = config;
    // Only PortAudio-backed platforms (macOS, and any non-ALSA/non-Windows
    // Direwolf build) need this — see _probeDefaultDevices for why.
    if (!config.audioInputDevice && !config.audioOutputDevice && process.platform !== 'linux' && process.platform !== 'win32') {
      const defaults = await this._probeDefaultDevices(bin);
      if (defaults) effectiveConfig = { ...config, audioInputDevice: defaults.input, audioOutputDevice: defaults.output };
    }

    const port = await this._reservePort();
    // A second, real AGWPE port alongside KISS — Direwolf happily serves
    // both protocols off the same running instance. NexPack's own AX.25
    // stack (TncManager) only ever needs the KISS port, but `pat` (the
    // Winlink client) can't speak KISS at all — its ax25 engine only knows
    // AGWPE — so this is what lets "Built-in Sound Modem" be picked as a
    // Winlink RF radio at all.
    const agwPort = await this._reservePort();
    const confPath = this._confPathFor(tncId);
    fs.writeFileSync(confPath, this._buildConfig({ ...effectiveConfig, port, agwPort }));

    const proc = spawn(bin, ['-c', confPath, '-t', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const inst = { proc, port, agwPort, confPath };
    this.instances.set(tncId, inst);

    proc.stdout.on('data', (d) => this.emit('log', { tncId, line: d.toString() }));
    proc.stderr.on('data', (d) => this.emit('log', { tncId, line: d.toString() }));

    let spawnError = null;
    let starting = true;
    proc.on('error', (err) => {
      spawnError = err;
      this.instances.delete(tncId);
      if (!starting) this.emit('error', { tncId, error: err });
    });
    proc.on('exit', (code) => {
      this.instances.delete(tncId);
      this.emit('exit', { tncId, code });
    });

    try {
      await this._waitForKissPort(port, 10000);
    } catch (e) {
      this.instances.delete(tncId);
      try { proc.kill('SIGKILL'); } catch (e2) { /* ignore */ }
      if (spawnError) {
        const friendly = spawnError.code === 'ENOENT'
          ? `Can't find "direwolf" — install it (macOS: "brew install direwolf", Debian/Ubuntu: "sudo apt install direwolf", Windows: download from github.com/wb2osz/direwolf/releases and put it on PATH) or set NEXPACK_DIREWOLF_PATH.`
          : `direwolf failed to start: ${spawnError.message}`;
        throw new Error(friendly);
      }
      throw new Error('direwolf did not open its KISS TCP port in time — check the audio device names in the sound modem settings.');
    } finally {
      starting = false;
    }

    return { port, agwPort };
  }

  async stopFor(tncId) {
    const inst = this.instances.get(tncId);
    if (!inst) return;
    this.instances.delete(tncId);
    inst.proc.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this._isAlive(inst.proc.pid)) { await new Promise((r) => setTimeout(r, 100)); }
    if (this._isAlive(inst.proc.pid)) { try { process.kill(inst.proc.pid, 'SIGKILL'); } catch (e) { /* ignore */ } }
  }

  async stopAll() {
    await Promise.all(Array.from(this.instances.keys()).map((tncId) => this.stopFor(tncId)));
  }

  _isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  }

  // Direwolf's KISSPORT directive rejects anything above 49151 ("Use
  // something in the range of 1024 to 49151") — found by actually running
  // the real bundled binary, not just the fake stand-in in the test suite,
  // which doesn't validate the port value at all. `listen(0)` (ask the OS
  // for any free ephemeral port) turned out to be USELESS here, not just
  // occasionally wrong: macOS's ephemeral range (net.inet.ip.portrange.*)
  // starts at 49152, so listen(0) basically never returns anything <=
  // 49151 — confirmed by 20/20 real attempts all landing above it. Picking
  // our own candidate port directly in Direwolf's accepted range and
  // retrying on collision is the only approach that actually works.
  async _reservePort() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidate = 20000 + Math.floor(Math.random() * (49151 - 20000));
      const ok = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(candidate, '127.0.0.1', () => srv.close(() => resolve(true)));
      });
      if (ok) return candidate;
    }
    throw new Error('could not find a free TCP port at or below 49151 for direwolf\'s KISS port');
  }

  _waitForKissPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
        sock.on('error', () => {
          sock.destroy();
          if (Date.now() >= deadline) return reject(new Error('timeout'));
          setTimeout(attempt, 200);
        });
      };
      attempt();
    });
  }

  // Direwolf's Linux backend (ALSA) accepts the literal word "default" as a
  // real "use the system's default device" value, and its Windows backend
  // (WINMM, a completely separate source file from the one below) accepts
  // an empty/omitted ADEVICE the same way its own docs describe. Neither of
  // those needs any help from NexPack. macOS — and any other Direwolf build
  // using the PortAudio backend — is the odd one out: see
  // _probeDefaultDevices for why an actual device name has to be resolved
  // before starting it there.
  // Direwolf's PortAudio backend (audio_portaudio.c, used on macOS and any
  // non-ALSA/non-Windows/non-sndio build) flatly rejects an empty device
  // name ("Input device name null") before it ever gets to interpret it as
  // "pick the default" — despite audio.h's own comment claiming an empty
  // string means "default audio device" on macOS. There is also no
  // universal "-" or "default" sentinel it accepts either: "-" means "pipe
  // raw audio through stdin/stdout" (a completely different, scripting-only
  // mode), and "default" isn't recognized by name on this backend the way
  // it is on ALSA. All confirmed by actually running the bundled binary,
  // not by reading its docs, which turned out to be wrong on this point.
  //
  // What DOES work: Direwolf itself prints the full device list — with the
  // real OS default input/output each tagged "[ Default Input ]" / "[
  // Default Output ]" — whenever a requested device name doesn't match
  // anything, right before it gives up and exits. So rather than needing a
  // separate native audio-enumeration dependency, a short-lived probe run
  // (deliberately requesting a device name that can't exist) makes Direwolf
  // hand us its own real default device names, which are then written into
  // the actual config used to start it for real. Cached per binary path
  // since the answer won't change without an OS-level device change anyway.
  async _probeDefaultDevices(bin) {
    if (this._probeCache.has(bin)) return this._probeCache.get(bin);
    const output = await this._runDeviceProbe(bin);
    const input = /\[\s*Default Input\s*\][\s\S]*?Name\s*=\s*"([^"]+)"/.exec(output);
    const outputMatch = /\[\s*Default Output\s*\][\s\S]*?Name\s*=\s*"([^"]+)"/.exec(output);
    const result = (input && outputMatch) ? { input: input[1], output: outputMatch[1] } : null;
    if (!result) this.emit('log', { tncId: null, line: 'Could not detect a default audio device automatically — please set one explicitly in the sound modem settings.\n' });
    this._probeCache.set(bin, result);
    return result;
  }

  // Runs the same "request an impossible device name" probe as
  // _probeDefaultDevices, but returns the raw text so callers can parse out
  // whatever they need (just the two defaults, or — see listAudioDevices —
  // every device Direwolf actually sees). One retry with a longer window:
  // CoreAudio device enumeration can occasionally take a while under load
  // (observed running right after several other Direwolf processes had just
  // been spawned back-to-back), though it normally returns in well under a
  // second.
  async _runDeviceProbe(bin) {
    const confPath = path.join(this.dataDir, '_probe.conf');
    fs.writeFileSync(confPath, [
      'ADEVICE __nexpack-probe-nonexistent-device__ __nexpack-probe-nonexistent-device__',
      'CHANNEL 0',
      'MYCALL N0CALL',
      'KISSPORT 12345'
    ].join(os.EOL) + os.EOL);

    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await new Promise((resolve) => {
        let buf = '';
        const proc = spawn(bin, ['-c', confPath, '-t', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const done = (() => { let called = false; return () => { if (called) return; called = true; try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ } resolve(buf); }; })();
        proc.stdout.on('data', (d) => { buf += d.toString(); if (/Pointless to continue/.test(buf)) done(); });
        proc.on('error', () => done());
        proc.on('exit', () => done());
        setTimeout(done, 8000);
      });
      if (/Number of devices/.test(output)) return output;
    }
    return '';
  }

  // Populates the audio device dropdowns in the Add TNC dialog with real
  // device names/tokens Direwolf itself will actually accept — rather than
  // free text the user has to somehow discover correctly, which is exactly
  // the class of mistake _probeDefaultDevices above was built to avoid.
  //
  // Only macOS (PortAudio) and Linux (ALSA) are populated for real:
  // - macOS reuses the same probe run as _probeDefaultDevices, parsing
  //   every "device #N" block instead of only the two default-tagged ones,
  //   split into inputs/outputs by which have Max inputs/outputs > 0.
  // - Linux has no equivalent listing built into Direwolf's ALSA backend
  //   (confirmed in audio.c — it calls snd_pcm_open() directly with
  //   whatever string it's given, no enumeration on failure) — so this
  //   reads /proc/asound/cards instead (always present when ALSA has any
  //   hardware, no extra package needed) and builds "plughw:CARD=<id>,DEV=0"
  //   tokens, which Direwolf's ALSA open call accepts directly.
  // - Windows' WINMM backend (audio_win.c) *does* print a device list
  //   unconditionally, by index and name — but that's unverified here since
  //   this environment has no way to actually run a Windows binary (no
  //   Wine). Left returning an empty list rather than shipping unverified
  //   parsing; the UI's free-text entry still works for Windows users.
  //
  // Cached per binary path, same reasoning as _probeDefaultDevices.
  async listAudioDevices() {
    const bin = this._resolveBinaryPath();
    if (this._deviceListCache && this._deviceListCache.bin === bin) return this._deviceListCache.result;

    let result = { inputs: [], outputs: [] };
    if (process.platform === 'darwin') {
      const output = await this._runDeviceProbe(bin);
      const inputs = [];
      const outputs = [];
      const blockRe = /---+ device #\d+\n([\s\S]*?)(?=---+ device #\d+|\nRequested|\nRunning off|$)/g;
      let m;
      while ((m = blockRe.exec(output)) !== null) {
        const block = m[1];
        const name = /Name\s*=\s*"([^"]+)"/.exec(block);
        const maxIn = /Max inputs\s*=\s*(\d+)/.exec(block);
        const maxOut = /Max outputs\s*=\s*(\d+)/.exec(block);
        if (!name) continue;
        const isDefaultIn = /\[\s*Default Input\s*\]/.test(block);
        const isDefaultOut = /\[\s*Default Output\s*\]/.test(block);
        if (maxIn && Number(maxIn[1]) > 0) inputs.push({ name: name[1], isDefault: isDefaultIn });
        if (maxOut && Number(maxOut[1]) > 0) outputs.push({ name: name[1], isDefault: isDefaultOut });
      }
      result = { inputs, outputs };
    } else if (process.platform === 'linux') {
      const cards = this._readAlsaCards();
      result = { inputs: cards, outputs: cards };
    }
    this._deviceListCache = { bin, result };
    return result;
  }

  _readAlsaCards() {
    let text;
    try { text = fs.readFileSync('/proc/asound/cards', 'utf8'); } catch (e) { return []; }
    const cards = [];
    // Real line shape: " 0 [PCH            ]: HDA-Intel - HDA Intel PCH"
    const lineRe = /^\s*(\d+)\s+\[([^\]]+)\]:\s*(.+)$/gm;
    let m;
    while ((m = lineRe.exec(text)) !== null) {
      const index = m[1];
      const id = m[2].trim();
      const desc = m[3].trim();
      cards.push({ name: `plughw:CARD=${id},DEV=0`, label: `${desc} (card ${index})`, isDefault: false });
    }
    return cards;
  }

  // Direwolf's config file format: https://github.com/wb2osz/direwolf/blob/master/doc/User-Guide.pdf
  // Real device names routinely contain spaces (CoreAudio: "MacBook Pro
  // Microphone") — Direwolf's config line tokenizer splits on whitespace
  // like a shell, only keeping spaces together when quoted (verified in
  // config.c's get_token()). Without quoting, "ADEVICE MacBook Pro
  // Microphone MacBook Pro Speakers" silently becomes four bogus
  // single-word device names instead of two real ones (found running the
  // real bundled binary against its own real default device names — it
  // took "MacBook" as the whole input device and failed).
  _buildConfig({ audioInputDevice, audioOutputDevice, pttMethod, pttDevice, callsign, port, agwPort }) {
    const inDev = (audioInputDevice || '').trim();
    const outDev = (audioOutputDevice || '').trim();
    const lines = [];
    if (inDev || outDev) {
      const q = (s) => `"${s.replace(/"/g, '')}"`;
      lines.push(`ADEVICE ${q(inDev || outDev)} ${q(outDev || inDev)}`);
    } else if (process.platform === 'linux') {
      lines.push('ADEVICE default default');
    }
    // Else (win32, or macOS/PortAudio when the probe above already filled
    // in real device names): no ADEVICE line, which is correct for win32's
    // own default handling, and for macOS effectiveConfig always has real
    // device names by the time this runs.
    lines.push(
      'ACHANNELS 1',
      'CHANNEL 0',
      `MYCALL ${(callsign || 'N0CALL').toUpperCase()}`,
      'MODEM 1200',
      `KISSPORT ${port}`,
      `AGWPORT ${agwPort || 0}`
    );
    switch (pttMethod) {
      case 'cm108':
        lines.push(`PTT CM108${pttDevice ? ' ' + pttDevice : ''}`);
        break;
      case 'rts':
        if (pttDevice) lines.push(`PTT ${pttDevice} RTS`);
        break;
      case 'dtr':
        if (pttDevice) lines.push(`PTT ${pttDevice} DTR`);
        break;
      case 'vox':
        // VOX PTT is keyed by the radio/interface hearing audio, not by
        // Direwolf — there's no "PTT VOX" directive in Direwolf itself, so
        // this intentionally emits no PTT line (same as 'none' below), kept
        // as a separate case for the UI's own labeling.
        break;
      case 'none':
      default:
        break; // no PTT line: fine for receive-only testing, Direwolf just warns
    }
    return lines.join(os.EOL) + os.EOL;
  }
}

module.exports = SoundModemManager;
