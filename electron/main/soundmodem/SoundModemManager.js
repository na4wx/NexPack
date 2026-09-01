const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
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
// this app ships (Windows: yes, from upstream GitHub releases; macOS:
// Homebrew bottle only, no standalone download; Linux: distro packages
// only). So v1 does NOT bundle a binary — it looks for one on PATH (or an
// explicit override), same as any other "bring your own TNC" dependency
// this app already assumes (soundmodem/direwolf itself, AGWPE host
// software, etc). `_resolveBinaryPath` still checks a bundled location
// first so a future release can drop platform binaries in without any
// other code changing, exactly like PatManager's asymmetric bundling.
class SoundModemManager extends EventEmitter {
  constructor({ userDataDir, resourcesPath }) {
    super();
    this.dataDir = path.join(userDataDir, 'soundmodem');
    this.resourcesPath = resourcesPath;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.instances = new Map(); // tncId -> { proc, port, confPath }
  }

  _resolveBinaryPath() {
    if (process.env.NEXPACK_DIREWOLF_PATH) return process.env.NEXPACK_DIREWOLF_PATH;
    if (this.resourcesPath) {
      const bin = process.platform === 'win32' ? 'direwolf.exe' : 'direwolf';
      const bundled = path.join(this.resourcesPath, 'direwolf', process.platform, process.arch, bin);
      if (fs.existsSync(bundled)) return bundled;
    }
    return process.platform === 'win32' ? 'direwolf.exe' : 'direwolf';
  }

  isRunning(tncId) {
    return this.instances.has(tncId);
  }

  // config: { audioInputDevice, audioOutputDevice, pttMethod ('vox'|'cm108'|'rts'|'dtr'|'none'), pttDevice, callsign }
  async startFor(tncId, config) {
    if (this.instances.has(tncId)) return { port: this.instances.get(tncId).port };

    const port = await this._reservePort();
    const confPath = path.join(this.dataDir, `${tncId}.conf`);
    fs.writeFileSync(confPath, this._buildConfig({ ...config, port }));

    const bin = this._resolveBinaryPath();
    const proc = spawn(bin, ['-c', confPath, '-t', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const inst = { proc, port, confPath };
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

    return { port };
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

  _reservePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
      srv.on('error', reject);
    });
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

  // Direwolf's config file format: https://github.com/wb2osz/direwolf/blob/master/doc/User-Guide.pdf
  // ADEVICE takes the input and output device names as Direwolf/PortAudio
  // understands them (platform-specific — CoreAudio names on macOS, ALSA
  // hint names on Linux, PortAudio device names on Windows); "-" means
  // "system default" on any platform and is what NexPack offers as the
  // out-of-the-box choice.
  _buildConfig({ audioInputDevice, audioOutputDevice, pttMethod, pttDevice, callsign, port }) {
    const inDev = (audioInputDevice || '-').trim() || '-';
    const outDev = (audioOutputDevice || '-').trim() || '-';
    const lines = [
      `ADEVICE ${inDev} ${outDev}`,
      'ACHANNELS 1',
      'CHANNEL 0',
      `MYCALL ${(callsign || 'N0CALL').toUpperCase()}`,
      'MODEM 1200',
      `KISSPORT ${port}`,
      'AGWPORT 0'
    ];
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
