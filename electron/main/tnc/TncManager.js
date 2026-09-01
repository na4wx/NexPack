const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseAx25Frame, buildAx25Frame } = require('../ax25/ax25');
const { escapeFrame, unescapeStream } = require('../ax25/kiss');
const SerialKissAdapter = require('../adapters/SerialKissAdapter');
const KissTcpAdapter = require('../adapters/KissTcpAdapter');
const AgwpeAdapter = require('../adapters/AgwpeAdapter');
const SessionLogger = require('./SessionLogger');
const { YappSender, YappReceiver } = require('./yapp');

const CTL = {
  UI: 0x03,
  SABM: 0x2f, SABM_P: 0x3f,
  UA: 0x63, UA_F: 0x73,
  DISC: 0x43, DISC_P: 0x53,
  DM: 0x0f, DM_F: 0x1f
};

const S_TYPE = { RR: 0, REJ: 1, RNR: 2 };

// Supervisory (RR/REJ/RNR) control byte: bit0=1,bit1=0 (fixed), bits2-3 =
// S-type, bit4 = P/F, bits5-7 = N(R).
function buildSupervisoryControl(sType, nr, pf) {
  return ((nr & 0x07) << 5) | (pf ? 0x10 : 0) | ((sType & 0x03) << 2) | 0x01;
}

function parseSupervisory(control) {
  return { sType: (control >> 2) & 0x03, pf: (control & 0x10) !== 0, nr: (control >> 5) & 0x07 };
}

// A real AX.25 connect must retry the SABM if no UA comes back — a remote
// that's out of range, busy, or slow to respond is the normal case on RF,
// not an error. Every real TNC/AX.25 stack does this (paKet relies on the
// TNC's own firmware for it); NexPack implements the AX.25 layer itself,
// so this has to live here.
const SABM_RETRY_COUNT = 5;
const SABM_RETRY_MS = 6000;

// Same story for outstanding I-frames: a real AX.25 stack keeps every
// unacknowledged I-frame around and retransmits it — on an explicit REJ
// from the peer, or if T1 expires with no ack at all (RR/REJ/piggybacked
// N(R) lost on the air is the normal case on RF, not an error). Without
// this, a single lost frame permanently desyncs N(S)/N(R) and the session
// just grinds to a halt while both sides silently disagree about state.
const IFRAME_RETRY_COUNT = 5;
const IFRAME_RETRY_MS = 10000;

// Modulo-8 sequencing only has room for 7 unacked frames before N(S) wraps
// and collides with an old one; real stacks cap outstanding frames well
// below that (4 is the common default "k" window). Without this, anything
// that sends several frames back-to-back (a pasted multi-line paste, a
// script, and especially YAPP file transfer's chunk loop) blows straight
// through the window on any link slower than the local send rate — which
// is most real RF — corrupting or stalling the transfer.
const MAX_OUTSTANDING_IFRAMES = 4;

// T3: if a connected session has been completely silent (nothing sent or
// received) for this long, poll the peer ourselves rather than just sitting
// there — otherwise a peer that silently vanished (powered off, out of
// range) leaves the session showing "connected" forever with nothing to
// ever notice the difference.
const T3_IDLE_MS = 5 * 60 * 1000;
const T3_MISSED_POLL_LIMIT = 3;

function classifyControl(control) {
  const isSABM = control === CTL.SABM || control === CTL.SABM_P || control === 0x6f;
  const isUA = (control & ~0x10) === CTL.UA;
  const isDISC = (control & ~0x10) === CTL.DISC;
  const isDM = (control & ~0x10) === CTL.DM;
  const isUI = control === CTL.UI;
  const isSupervisory = (control & 0x03) === 0x01;
  const isI = (control & 0x01) === 0x00 && !isSABM;
  if (isSABM) return 'sabm';
  if (isUA) return 'ua';
  if (isDISC) return 'disc';
  if (isDM) return 'dm';
  if (isUI) return 'ui';
  if (isSupervisory) return 'supervisory';
  if (isI) return 'iframe';
  return 'unknown';
}

function id() { return crypto.randomUUID(); }

// Owns every configured TNC + its radios, the live adapter connections, and
// lightweight connected-mode sessions for the terminal. This is the piece
// NexDigi has no equivalent of (its channelManager.js is a flat
// channel->adapter map with no TNC/radio hierarchy) — deliberately new.
class TncManager extends EventEmitter {
  constructor({ configPath, userDataDir, soundModemManager, sabmRetryMs, sabmRetryCount, iframeRetryMs, iframeRetryCount, maxOutstandingIframes, t3IdleMs, t3MissedPollLimit } = {}) {
    super();
    this.configPath = configPath;
    this.soundModemManager = soundModemManager || null;
    this.tncs = new Map(); // id -> { config: {id,name,type,connection,radios:[]}, adapter, status, rxBuffer }
    this.sessions = new Map(); // sessionId -> session state
    this.sessionLogger = userDataDir ? new SessionLogger({ userDataDir }) : null;
    // Overridable only for tests, which can't afford the real worst-case timing.
    this.sabmRetryMs = sabmRetryMs || SABM_RETRY_MS;
    this.sabmRetryCount = sabmRetryCount !== undefined ? sabmRetryCount : SABM_RETRY_COUNT;
    this.iframeRetryMs = iframeRetryMs || IFRAME_RETRY_MS;
    this.iframeRetryCount = iframeRetryCount !== undefined ? iframeRetryCount : IFRAME_RETRY_COUNT;
    this.maxOutstandingIframes = maxOutstandingIframes || MAX_OUTSTANDING_IFRAMES;
    this.t3IdleMs = t3IdleMs || T3_IDLE_MS;
    this.t3MissedPollLimit = t3MissedPollLimit !== undefined ? t3MissedPollLimit : T3_MISSED_POLL_LIMIT;
    this._load();
  }

  // ---- persistence ----
  _load() {
    if (!this.configPath) return;
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const list = JSON.parse(raw);
      for (const config of list) this.tncs.set(config.id, { config, adapter: null, status: 'disconnected', rxBuffer: Buffer.alloc(0) });
    } catch (e) { /* no config yet */ }
  }

  _save() {
    if (!this.configPath) return;
    const list = Array.from(this.tncs.values()).map((t) => t.config);
    try { fs.writeFileSync(this.configPath, JSON.stringify(list, null, 2)); } catch (e) { this.emit('error', e); }
  }

  // ---- TNC / radio CRUD ----
  listTncs() {
    return Array.from(this.tncs.values()).map((t) => ({ ...t.config, status: t.status }));
  }

  createTnc({ name, type, connection }) {
    const config = { id: id(), name, type, connection, radios: [] };
    this.tncs.set(config.id, { config, adapter: null, status: 'disconnected', rxBuffer: Buffer.alloc(0) });
    this._save();
    this.emit('tnc-list-changed');
    return config;
  }

  updateTnc(tncId, patch) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    Object.assign(t.config, patch);
    this._save();
    this.emit('tnc-list-changed');
  }

  removeTnc(tncId) {
    this.disconnectTnc(tncId);
    this.tncs.delete(tncId);
    this._save();
    this.emit('tnc-list-changed');
  }

  addRadio(tncId, { callsign, name, portNumber = 0 }) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    const radio = { id: id(), callsign, name, portNumber };
    t.config.radios.push(radio);
    this._save();
    this.emit('tnc-list-changed');
    return radio;
  }

  removeRadio(tncId, radioId) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    t.config.radios = t.config.radios.filter((r) => r.id !== radioId);
    this._save();
    this.emit('tnc-list-changed');
  }

  // ---- connection lifecycle ----
  // Async because the 'soundmodem' type has to spawn and wait on a Direwolf
  // subprocess before there's a KISS port to connect an adapter to — every
  // other type resolves synchronously and just returns an already-resolved
  // promise, so nothing about their behavior (or existing callers that treat
  // this as fire-and-forget) changes.
  async connectTnc(tncId) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    if (t.adapter || t.status === 'connecting') return; // already connecting/connected
    const conn = t.config.connection || {};
    if (t.config.type === 'serial') {
      t.adapter = new SerialKissAdapter({ port: conn.path, baud: conn.baud || 9600 });
    } else if (t.config.type === 'kiss-tcp') {
      t.adapter = new KissTcpAdapter({ host: conn.host, port: conn.port });
    } else if (t.config.type === 'agwpe') {
      t.adapter = new AgwpeAdapter({ host: conn.host, port: conn.port, callsign: (t.config.radios[0] && t.config.radios[0].callsign) || 'N0CALL' });
    } else if (t.config.type === 'soundmodem') {
      if (!this.soundModemManager) throw new Error('sound modem support is not available');
      this._setStatus(t, 'connecting');
      let port;
      try {
        ({ port } = await this.soundModemManager.startFor(tncId, {
          ...conn,
          callsign: (t.config.radios[0] && t.config.radios[0].callsign) || 'N0CALL'
        }));
      } catch (e) {
        this._setStatus(t, 'error', e);
        return;
      }
      t.adapter = new KissTcpAdapter({ host: '127.0.0.1', port });
      this._wireAdapter(t);
      return;
    } else {
      throw new Error(`unknown TNC type: ${t.config.type}`);
    }
    this._wireAdapter(t);
    this._setStatus(t, 'connecting');
  }

  async disconnectTnc(tncId) {
    const t = this.tncs.get(tncId);
    if (!t) return;
    if (t.adapter) {
      try { t.adapter.close(); } catch (e) { /* ignore */ }
      t.adapter = null;
    }
    this._setStatus(t, 'disconnected');
    if (t.config.type === 'soundmodem' && this.soundModemManager) {
      await this.soundModemManager.stopFor(tncId);
    }
  }

  _setStatus(t, status, error) {
    t.status = status;
    this.emit('tnc-status', { tncId: t.config.id, status, error: error ? String(error.message || error) : null });
  }

  _wireAdapter(t) {
    const { adapter, config } = t;
    adapter.on('open', () => this._setStatus(t, 'connected'));
    adapter.on('close', () => this._setStatus(t, 'disconnected'));
    adapter.on('error', (e) => this._setStatus(t, 'error', e));
    if (config.type === 'agwpe') {
      adapter.on('frame', ({ port, ax25Frame }) => this._handleIncomingAx25(t, port, ax25Frame));
      adapter.on('portInfo', (ports) => this.emit('port-info', { tncId: config.id, ports }));
    } else {
      adapter.on('data', (chunk) => this._onRawKissData(t, chunk));
    }
  }

  _radioForPort(t, portNumber) {
    return t.config.radios.find((r) => (r.portNumber || 0) === portNumber) || t.config.radios[0] || null;
  }

  // Same fixed-boundary KISS de-escaping approach NexDigi's channelManager.js
  // now uses (it originally had a byte-corruption bug from a hand-rolled
  // re-implementation that never de-escaped — built correctly here from the
  // start using the shared unescapeStream()).
  _onRawKissData(t, chunk) {
    t.rxBuffer = Buffer.concat([t.rxBuffer, chunk]);
    let processed = 0;
    for (;;) {
      const startFend = t.rxBuffer.indexOf(0xc0, processed);
      if (startFend === -1) break;
      const endFend = t.rxBuffer.indexOf(0xc0, startFend + 1);
      if (endFend === -1) break;
      const rawFrame = t.rxBuffer.slice(startFend, endFend + 1);
      try {
        for (const { port, frame } of unescapeStream(rawFrame)) {
          if (frame.length > 0) this._handleIncomingAx25(t, port, frame);
        }
      } catch (e) { /* skip invalid frame */ }
      processed = endFend + 1;
    }
    t.rxBuffer = t.rxBuffer.slice(processed);
    if (t.rxBuffer.length > 8192) t.rxBuffer = Buffer.alloc(0); // safety valve against garbage streams
  }

  // Returns false (instead of throwing) if the TNC's adapter is gone — e.g.
  // it was disconnected while a session was still live. Retry timers run on
  // their own schedule with nothing to catch a throw, so a plain crash here
  // would take down the whole app (the exact class of bug already fixed
  // once today for a null adapter reached via a different path); every
  // caller either already checked t.adapter itself (and can treat false as
  // "shouldn't happen") or is a retry loop that needs to back off cleanly.
  _txAx25Frame(t, radio, ax25Frame) {
    if (!t.adapter) return false;
    if (t.config.type === 'agwpe') {
      t.adapter.sendFrame(radio ? radio.portNumber || 0 : 0, ax25Frame, { callFrom: radio && radio.callsign });
    } else {
      t.adapter.send(escapeFrame(ax25Frame, radio ? radio.portNumber || 0 : 0));
    }
    return true;
  }

  _emitMonitor(t, radio, direction, frameType, parsed, raw) {
    let text;
    try { text = parsed.payload && parsed.payload.length ? parsed.payload.toString('utf8') : ''; } catch (e) { text = ''; }
    this.emit('monitor', {
      tncId: t.config.id,
      radioId: radio ? radio.id : null,
      direction,
      frameType,
      timestamp: Date.now(),
      addresses: (parsed.addresses || []).map((a) => `${a.callsign}${a.ssid ? '-' + a.ssid : ''}`),
      control: parsed.control,
      text,
      raw: raw.toString('hex')
    });
  }

  // ---- inbound frame handling ----
  // Takes the raw KISS/AGWPE port number rather than a pre-resolved radio —
  // which radio a frame is "for" can only be known once it's parsed and its
  // destination callsign-SSID is matched against the radios actually
  // configured on that port. Picking a radio by port alone (the old
  // behavior) meant multiple radios sharing one physical port — needed for
  // giving Terminal/BBS/Chat each their own callsign-SSID on one TNC —
  // would all resolve to whichever radio happened to be listed first,
  // regardless of which one a frame was actually addressed to.
  _handleIncomingAx25(t, portNumber, ax25Frame) {
    let parsed;
    try { parsed = parseAx25Frame(ax25Frame); } catch (e) {
      this.emit('monitor', { tncId: t.config.id, radioId: null, direction: 'rx', frameType: 'error', timestamp: Date.now(), text: `malformed frame: ${e.message}`, raw: ax25Frame.toString('hex') });
      return;
    }
    if (!parsed.addresses || parsed.addresses.length < 2) return;
    const destAddr = parsed.addresses[0];
    const destCall = destAddr.ssid ? `${destAddr.callsign}-${destAddr.ssid}` : destAddr.callsign;
    const onThisPort = t.config.radios.filter((r) => (r.portNumber || 0) === portNumber);
    let radio = onThisPort.find((r) => String(r.callsign || '').toUpperCase() === destCall.toUpperCase());
    if (!radio) radio = this._radioForPort(t, portNumber); // fallback: monitor display still needs a radio to attribute to

    const frameType = classifyControl(parsed.control);
    this._emitMonitor(t, radio, 'rx', frameType, parsed, ax25Frame);

    if (!radio) return;
    const srcAddr = parsed.addresses[1];
    const srcCall = srcAddr.ssid ? `${srcAddr.callsign}-${srcAddr.ssid}` : srcAddr.callsign;
    // Full callsign-SSID match now, not just the base callsign — the old
    // check stripped the SSID off both sides, so two radios differing only
    // by SSID would both accept every frame addressed to either of them.
    const addressedToUs = destCall.toUpperCase() === String(radio.callsign || '').toUpperCase();
    if (!addressedToUs) return;

    const sessionKey = `${t.config.id}:${radio.id}:${srcCall}`;
    let session = this.sessions.get(sessionKey);

    if (frameType === 'sabm') {
      session = session || this._newSession(t, radio, srcCall, sessionKey);
      session.state = 'connected';
      session.vr = 0; session.vs = 0;
      session.pendingRx.clear();
      session.recentDeliveries = [];
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: CTL.UA_F, pid: null, payload: Buffer.alloc(0) }));
      if (this.sessionLogger) this.sessionLogger.startLog(session);
      this.emit('session-state', this._sessionSnapshot(session));
      session.t3MissedPolls = 0;
      this._armT3(t, radio, session);
    } else if (frameType === 'ua' && session && session.state === 'connecting') {
      this._clearSabmRetry(session);
      session.state = 'connected';
      if (this.sessionLogger) this.sessionLogger.startLog(session);
      this.emit('session-state', this._sessionSnapshot(session));
      session.t3MissedPolls = 0;
      this._armT3(t, radio, session);
    } else if (frameType === 'disc' && session) {
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: CTL.UA_F, pid: null, payload: Buffer.alloc(0) }));
      this._teardownConnected(session);
    } else if (frameType === 'dm' && session && session.state === 'connecting') {
      // The remote explicitly refused the connection (e.g. "not accepting
      // connects" or a busy port) — no point blindly retrying the SABM for
      // up to ~30s when it already told us no.
      this._giveUp(session, `Connection refused by ${session.remoteCall}.`);
    } else if (frameType === 'dm' && session && session.state === 'connected') {
      // The remote's own stack reset/forgot us without a proper DISC (e.g.
      // its TNC rebooted) — nothing to reply to, just stop pretending we're
      // still connected on our end too.
      this._teardownConnected(session);
    } else if (frameType === 'iframe' && session && session.state === 'connected') {
      const ns = (parsed.control >> 1) & 0x07;
      const incomingPf = (parsed.control & 0x10) !== 0;
      const nr = (parsed.control >> 5) & 0x07;
      this._ackFrames(t, radio, session, nr);
      // Real-world peers aren't always perfectly sequenced (a burst of
      // frames can arrive out of send order even when none are actually
      // lost) — rejecting or dropping data on a mismatch risks losing
      // content a lenient real terminal would have shown, but delivering
      // it immediately in *arrival* order instead of *send* order garbles
      // the transcript (confirmed live: the tail of a multi-frame reply
      // showed up interleaved with a later command's response). Frames
      // that arrive ahead of what we expect are buffered and only
      // delivered once the gap in front of them fills in; a frame that's
      // behind is a stale duplicate replay of something already delivered
      // and gets silently discarded instead of re-delivered out of order.
      if (ns === session.vr) {
        // Modulo-8 sequencing can't tell "the next new frame" from "a full
        // pass (8 frames) worth of retransmission that happens to land back
        // on this exact number" — both look identical to a bare ns===vr
        // check. Confirmed live: a peer whose burst spanned the whole
        // sequence space kept retransmitting its entire reply because
        // something never satisfied it, and this ambiguity meant we kept
        // treating every replay as brand-new data — re-displaying the same
        // content forever and (worse) re-advancing V(R) each time, feeding
        // the peer an ack sequence that no longer corresponded to reality.
        // A byte-identical repeat of something delivered moments ago is
        // recognized as a retransmit instead: re-acked with the CURRENT,
        // unchanged V(R) (the spec-correct response to a duplicate) rather
        // than advancing past it again.
        if (this._isDuplicateDelivery(session, ns, parsed.payload)) {
          // fall through to send the unchanged ack below
        } else {
          session.vr = (ns + 1) % 8;
          this._deliverIframePayload(session, parsed.payload);
          this._recordDelivery(session, ns, parsed.payload);
          while (session.pendingRx.has(session.vr)) {
            const bufferedNs = session.vr;
            const buffered = session.pendingRx.get(bufferedNs);
            session.pendingRx.delete(bufferedNs);
            session.vr = (session.vr + 1) % 8;
            this._deliverIframePayload(session, buffered);
            this._recordDelivery(session, bufferedNs, buffered);
          }
        }
      } else {
        const distance = (ns - session.vr + 8) % 8;
        if (distance <= 4) session.pendingRx.set(ns, parsed.payload);
      }
      const rrControl = buildSupervisoryControl(S_TYPE.RR, session.vr, incomingPf);
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: rrControl, pid: null, payload: Buffer.alloc(0) }));
      session.t3MissedPolls = 0;
      this._armT3(t, radio, session);
    } else if (frameType === 'supervisory' && session && session.state === 'connected') {
      const { sType, pf, nr } = parseSupervisory(parsed.control);
      this._ackFrames(t, radio, session, nr);
      if (sType === S_TYPE.RNR) {
        // "Stop sending, I'm busy" — pause outbound I-frames (queued or
        // retried) until an RR/REJ says the peer is ready again, instead of
        // hammering a receiver that just told us not to.
        session.peerBusy = true;
      } else {
        if (session.peerBusy) { session.peerBusy = false; this._pumpSendQueue(t, radio, session); }
        if (sType === S_TYPE.REJ) {
          // The peer is telling us it's expecting N(S)=nr next — everything
          // we sent from there on was either lost or arrived out of
          // sequence and got discarded, so it has to go back out exactly
          // as before.
          const ok = this._retransmitOutstanding(t, radio, session);
          if (!ok) { this._giveUp(session, `TNC disconnected while talking to ${session.remoteCall}.`); return; }
        }
      }
      if (pf) {
        // A poll (P bit) demands an immediate response reporting our state,
        // regardless of frame type — without this, a peer's keep-alive check
        // just gets silently ignored until it gives up and disconnects.
        const respControl = buildSupervisoryControl(S_TYPE.RR, session.vr, true);
        const respFrame = buildAx25Frame({ dest: srcCall, src: radio.callsign, control: respControl, pid: null, payload: Buffer.alloc(0), path: session.path });
        this._txAx25Frame(t, radio, respFrame);
        this._emitMonitor(t, radio, 'tx', 'rr', { addresses: [{ callsign: srcCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: respControl, payload: Buffer.alloc(0) }, respFrame);
      }
      session.t3MissedPolls = 0;
      this._armT3(t, radio, session);
    } else if ((frameType === 'iframe' || frameType === 'supervisory') && (!session || session.state !== 'connected')) {
      // Data or session control addressed to us for a connection we don't
      // have (never had one, or it's still mid-handshake) — the compliant
      // reply is DM, not silence, so a well-behaved peer knows to stop
      // rather than keep talking into the void.
      const frame = buildAx25Frame({ dest: srcCall, src: radio.callsign, control: CTL.DM_F, pid: null, payload: Buffer.alloc(0) });
      this._txAx25Frame(t, radio, frame);
      this._emitMonitor(t, radio, 'tx', 'dm', { addresses: [{ callsign: srcCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.DM_F, payload: Buffer.alloc(0) }, frame);
    } else if (frameType === 'unknown' && session) {
      // A control byte we don't recognize at all, on a connection we do
      // have — tell the peer plainly (FRMR) rather than silently ignoring
      // it forever, which is what a stricter real station would do to us.
      const info = Buffer.from([parsed.control & 0xff, ((session.vr & 0x07) << 5) | (session.vs & 0x07), 0x01]);
      const frame = buildAx25Frame({ dest: srcCall, src: radio.callsign, control: 0x87, pid: null, payload: info, path: session.path });
      this._txAx25Frame(t, radio, frame);
      this._emitMonitor(t, radio, 'tx', 'frmr', { addresses: [{ callsign: srcCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: 0x87, payload: info }, frame);
    }
  }

  // Applies one received I-frame's payload to the session — YAPP transfer,
  // a fresh YAPP init, or plain text — exactly once, in correct N(S) order
  // (called either immediately or when draining session.pendingRx).
  _deliverIframePayload(session, payload) {
    const looksLikeYappInit = session.mode === 'text' && payload.length >= 2 && payload[0] === 0x05 && payload[1] === 0x01;
    if (session.mode === 'yapp' && session.yapp) {
      session.yapp.onBytes(payload);
    } else if (looksLikeYappInit) {
      this._beginIncomingOffer(session).onBytes(payload);
    } else {
      let text = '';
      try { text = payload.toString('utf8'); } catch (e) { /* ignore */ }
      session.buffer.push(text);
      if (this.sessionLogger) this.sessionLogger.appendLog(session, 'rx', text);
      this.emit('session-data', { sessionId: session.id, text });
    }
  }

  // Small ring buffer of what's actually been delivered recently, purely to
  // recognize a peer's full-window retransmission landing back on the same
  // ns by coincidence (see the comment where this is used). Deliberately
  // scoped to text mode only — YAPP binary chunks can be legitimately
  // byte-identical (e.g. a run of zero bytes in the file), where silently
  // dropping a "duplicate" would corrupt the transfer instead of just
  // re-showing a line of text.
  _recordDelivery(session, ns, payload) {
    if (session.mode !== 'text') return;
    session.recentDeliveries.push({ ns, payload, at: Date.now() });
    if (session.recentDeliveries.length > 16) session.recentDeliveries.shift();
  }

  _isDuplicateDelivery(session, ns, payload) {
    if (session.mode !== 'text') return false;
    const now = Date.now();
    return session.recentDeliveries.some((r) => r.ns === ns && now - r.at < 60000 && r.payload.equals(payload));
  }

  _ackFrames(t, radio, session, nr) {
    if (!session.sentFrames || session.sentFrames.length === 0) return;
    const front = session.sentFrames[0].ns;
    const ackedCount = Math.min((nr - front + 8) % 8, session.sentFrames.length);
    if (ackedCount > 0) session.sentFrames.splice(0, ackedCount);
    if (session.sentFrames.length === 0) this._clearIframeRetry(session);
    this._pumpSendQueue(t, radio, session);
  }

  // Returns false if transmission failed (adapter gone) so callers — all of
  // them retry paths running well after the frame was first queued — can
  // give up cleanly instead of crashing on a null adapter.
  _retransmitOutstanding(t, radio, session) {
    for (const f of session.sentFrames) {
      if (!this._txAx25Frame(t, radio, f.frame)) return false;
      this._emitMonitor(t, radio, 'tx', 'iframe', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: f.control, payload: f.payload }, f.frame);
    }
    return true;
  }

  // Actually puts a frame on the air now — only ever called when the
  // window has room. Everything else (sendSessionText, the queue pump,
  // YAPP) goes through _enqueueIframe instead.
  _transmitIframe(t, radio, session, payload) {
    const ns = session.vs & 0x07;
    const control = ((session.vr & 0x07) << 5) | (ns << 1);
    session.vs = (session.vs + 1) % 8;
    const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control, pid: 0xf0, payload, path: session.path });
    this._txAx25Frame(t, radio, frame);
    session.sentFrames.push({ ns, frame, control, payload });
    this._armIframeRetry(t, radio, session);
    this._armT3(t, radio, session);
    this._emitMonitor(t, radio, 'tx', 'iframe', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control, payload }, frame);
  }

  // Modulo-8 sequencing only has room for a handful of unacked frames
  // before N(S) wraps and collides with an old one. Sends immediately if
  // there's room in the window and the peer isn't RNR-busy; otherwise
  // queues the payload to go out as soon as there is. This is what protects
  // any rapid multi-frame send — a pasted multi-line paste, a script, and
  // especially YAPP's chunk loop, which has no flow-control awareness of
  // its own — from blowing straight through the window, which on a real RF
  // link (round-trip ack time often 1-3+ seconds) it otherwise would on
  // anything but a tiny transfer.
  _enqueueIframe(t, radio, session, payload) {
    if (session.sentFrames.length < this.maxOutstandingIframes && !session.peerBusy) {
      this._transmitIframe(t, radio, session, payload);
    } else {
      session.sendQueue.push(payload);
    }
  }

  _pumpSendQueue(t, radio, session) {
    while (session.sendQueue.length > 0 && session.sentFrames.length < this.maxOutstandingIframes && !session.peerBusy) {
      this._transmitIframe(t, radio, session, session.sendQueue.shift());
    }
  }

  _clearIframeRetry(session) {
    if (session.iframeRetryTimer) { clearTimeout(session.iframeRetryTimer); session.iframeRetryTimer = null; }
    session.iframeRetries = 0;
  }

  // Covers the case a REJ can't: if the peer's ack (or our frame) gets lost
  // on the air entirely, nothing ever arrives to trigger a retransmit. This
  // timer notices the silence and resends the same outstanding frames REJ
  // handling would have, up to IFRAME_RETRY_COUNT before giving up on the
  // session the same way the SABM retry does.
  _armIframeRetry(t, radio, session) {
    if (session.iframeRetryTimer) clearTimeout(session.iframeRetryTimer);
    session.iframeRetryTimer = setTimeout(() => {
      if (!this.sessions.has(session.key) || session.state !== 'connected' || session.sentFrames.length === 0) return;
      if (session.peerBusy) {
        // Don't hammer a receiver that just told us to back off — keep
        // waiting for it to clear RNR on its own schedule instead.
        this._armIframeRetry(t, radio, session);
        return;
      }
      if (session.iframeRetries >= this.iframeRetryCount) {
        this._giveUp(session, `Lost contact with ${session.remoteCall} — no acknowledgment after ${this.iframeRetryCount + 1} attempts.`);
        return;
      }
      session.iframeRetries += 1;
      if (!this._retransmitOutstanding(t, radio, session)) {
        this._giveUp(session, `TNC disconnected while talking to ${session.remoteCall}.`);
        return;
      }
      this._armIframeRetry(t, radio, session);
    }, this.iframeRetryMs);
  }

  _clearT3(session) {
    if (session.t3Timer) { clearTimeout(session.t3Timer); session.t3Timer = null; }
  }

  // If a connected session has been completely silent for T3_IDLE_MS, poll
  // the peer ourselves instead of just sitting there — otherwise a peer
  // that silently vanished (powered off, out of range) leaves the session
  // showing "connected" forever with nothing to ever notice the
  // difference. Any real traffic in either direction re-arms this (see the
  // callers), and a real reply from the peer resets the missed-poll count;
  // only our own unanswered polls count toward giving up.
  _armT3(t, radio, session) {
    this._clearT3(session);
    session.t3Timer = setTimeout(() => {
      if (!this.sessions.has(session.key) || session.state !== 'connected') return;
      const pollControl = buildSupervisoryControl(S_TYPE.RR, session.vr, true);
      const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control: pollControl, pid: null, payload: Buffer.alloc(0), path: session.path });
      if (!this._txAx25Frame(t, radio, frame)) {
        this._giveUp(session, `TNC disconnected while ${session.remoteCall} was connected.`);
        return;
      }
      this._emitMonitor(t, radio, 'tx', 'rr', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: pollControl, payload: Buffer.alloc(0) }, frame);
      session.t3MissedPolls = (session.t3MissedPolls || 0) + 1;
      if (session.t3MissedPolls > this.t3MissedPollLimit) {
        this._giveUp(session, `Lost contact with ${session.remoteCall} — no response to keep-alive poll.`);
        return;
      }
      this._armT3(t, radio, session);
    }, this.t3IdleMs);
  }

  // Shared teardown for every "the session is over, clean it up" path
  // (explicit disconnect, inbound DISC/DM, shutdown) — stops every timer,
  // aborts any in-progress file transfer, and removes the session. Callers
  // that need to notify the peer (DISC/UA) do that themselves first.
  _teardownConnected(session) {
    this._clearSabmRetry(session);
    this._clearIframeRetry(session);
    this._clearT3(session);
    session.state = 'disconnected';
    if (session.yapp) { try { session.yapp.abort(); } catch (e) { /* ignore */ } }
    if (this.sessionLogger) this.sessionLogger.stopLog(session);
    this.emit('session-state', this._sessionSnapshot(session));
    this.sessions.delete(session.key);
  }

  // Same teardown, plus a session-error explaining why — for every "we
  // gave up" path (SABM/I-frame/T3 retries exhausted, connection refused).
  _giveUp(session, message) {
    this._teardownConnected(session);
    this.emit('session-error', { sessionId: session.id, remoteCall: session.remoteCall, message });
  }

  // ---- outbound: unconnected (UI) ----
  sendUnproto(tncId, radioId, destCallsign, text) {
    const t = this.tncs.get(tncId);
    const radio = t.config.radios.find((r) => r.id === radioId);
    if (!t || !radio) throw new Error('unknown TNC/radio');
    const payload = Buffer.from(text, 'utf8');
    const frame = buildAx25Frame({ dest: destCallsign, src: radio.callsign, control: CTL.UI, pid: 0xf0, payload });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'ui', { addresses: [{ callsign: destCallsign, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.UI, payload }, frame);
  }

  // ---- outbound: connected-mode sessions ----
  _newSession(t, radio, remoteCall, sessionKey, digiPath, scriptId) {
    const session = { id: id(), key: sessionKey, tncId: t.config.id, radioId: radio.id, remoteCall, path: digiPath || [], state: 'connecting', vs: 0, vr: 0, buffer: [], mode: 'text', yapp: null, pendingScriptId: scriptId || null, logPath: null, retries: 0, retryTimer: null, sentFrames: [], sendQueue: [], peerBusy: false, iframeRetryTimer: null, iframeRetries: 0, t3Timer: null, t3MissedPolls: 0, pendingRx: new Map(), recentDeliveries: [] };
    this.sessions.set(sessionKey, session);
    return session;
  }

  _clearSabmRetry(session) {
    if (session.retryTimer) { clearTimeout(session.retryTimer); session.retryTimer = null; }
  }

  // Resends the SABM on a timer until a UA arrives, the session is torn
  // down, or SABM_RETRY_COUNT is exhausted — at which point the session is
  // marked disconnected and a session-error event fires so the UI can show
  // a real "no response" message instead of hanging in 'connecting' forever.
  _armSabmRetry(t, radio, session) {
    session.retryTimer = setTimeout(() => {
      if (!this.sessions.has(session.key) || session.state !== 'connecting') return;
      if (session.retries >= this.sabmRetryCount) {
        this._giveUp(session, `No response from ${session.remoteCall} after ${this.sabmRetryCount + 1} attempts.`);
        return;
      }
      session.retries += 1;
      const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control: CTL.SABM_P, pid: null, payload: Buffer.alloc(0), path: session.path });
      if (!this._txAx25Frame(t, radio, frame)) {
        this._giveUp(session, `TNC disconnected while connecting to ${session.remoteCall}.`);
        return;
      }
      this._emitMonitor(t, radio, 'tx', 'sabm', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.SABM_P, payload: Buffer.alloc(0) }, frame);
      this._armSabmRetry(t, radio, session);
    }, this.sabmRetryMs);
  }

  _sessionSnapshot(s) {
    return { id: s.id, tncId: s.tncId, radioId: s.radioId, remoteCall: s.remoteCall, path: s.path, state: s.state, mode: s.mode, logPath: s.logPath, pendingScriptId: s.pendingScriptId };
  }

  _findSession(sessionId) {
    return Array.from(this.sessions.values()).find((s) => s.id === sessionId);
  }

  startSession(tncId, radioId, remoteCall, digiPath, scriptId) {
    const t = this.tncs.get(tncId);
    const radio = t && t.config.radios.find((r) => r.id === radioId);
    if (!t || !radio) throw new Error('unknown TNC/radio');
    if (!t.adapter) throw new Error(`TNC "${t.config.name || tncId}" is not connected — connect it before starting a session.`);
    const sessionKey = `${tncId}:${radioId}:${remoteCall}`;
    const session = this._newSession(t, radio, remoteCall, sessionKey, digiPath, scriptId);
    const frame = buildAx25Frame({ dest: remoteCall, src: radio.callsign, control: CTL.SABM_P, pid: null, payload: Buffer.alloc(0), path: session.path });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'sabm', { addresses: [{ callsign: remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.SABM_P, payload: Buffer.alloc(0) }, frame);
    this._armSabmRetry(t, radio, session);
    return this._sessionSnapshot(session);
  }

  sendSessionText(sessionId, text) {
    const session = this._findSession(sessionId);
    if (!session || session.state !== 'connected') throw new Error('session not connected');
    if (session.mode === 'yapp') throw new Error('session is busy with a file transfer');
    const t = this.tncs.get(session.tncId);
    const radio = t.config.radios.find((r) => r.id === session.radioId);
    this._enqueueIframe(t, radio, session, Buffer.from(text, 'utf8'));
    if (this.sessionLogger) this.sessionLogger.appendLog(session, 'tx', text);
    this.emit('session-tx', { sessionId: session.id, text });
  }

  // For a human (or a connect script) typing a command line, as opposed to
  // sendSessionText's raw bytes-as-given (used by RfBbsClient, which drives
  // NexDigi's own BBS protocol exactly and adds its own terminators where
  // it needs them). Real packet BBS/node software (linbpq, etc.) expects
  // each line CR-terminated the way a real terminal sends Enter — without
  // it, the remote just keeps buffering, waiting for a line that never
  // arrives, and never responds at all (confirmed live: commands got
  // acked at the AX.25 layer but no application-level reply ever came).
  sendSessionLine(sessionId, text) {
    this.sendSessionText(sessionId, `${text}\r`);
  }

  // Raw-byte variant of sendSessionText, used internally by YAPP file transfer.
  sendSessionRaw(sessionId, buffer) {
    const session = this._findSession(sessionId);
    if (!session || session.state !== 'connected') throw new Error('session not connected');
    const t = this.tncs.get(session.tncId);
    const radio = t.config.radios.find((r) => r.id === session.radioId);
    this._enqueueIframe(t, radio, session, buffer);
  }

  endSession(sessionId) {
    const session = this._findSession(sessionId);
    if (!session) return;
    const t = this.tncs.get(session.tncId);
    const radio = t.config.radios.find((r) => r.id === session.radioId);
    const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control: CTL.DISC_P, pid: null, payload: Buffer.alloc(0), path: session.path });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'disc', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.DISC_P, payload: Buffer.alloc(0) }, frame);
    this._teardownConnected(session);
  }

  // ---- YAPP file transfer ----
  startFileSend(sessionId, filePath) {
    const session = this._findSession(sessionId);
    if (!session || session.state !== 'connected') throw new Error('session not connected');
    if (session.mode === 'yapp') throw new Error('a file transfer is already in progress on this session');
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    session.mode = 'yapp';
    const sender = new YappSender({
      sendRawFn: (buf) => this.sendSessionRaw(sessionId, buf),
      filename,
      data,
      onProgress: (p) => this.emit('file-transfer-progress', { sessionId, direction: 'send', filename, ...p }),
      onComplete: () => {
        session.mode = 'text'; session.yapp = null;
        if (this.sessionLogger) this.sessionLogger.appendNote(session, `sent file ${filename} (${data.length} bytes)`);
        this.emit('file-transfer-complete', { sessionId, direction: 'send', filename });
      },
      onError: (e) => {
        session.mode = 'text'; session.yapp = null;
        this.emit('file-transfer-error', { sessionId, direction: 'send', filename, message: e.message });
      }
    });
    session.yapp = sender;
    sender.start();
  }

  // Called on receipt of an unsolicited YAPP init while a session is idle in text mode.
  _beginIncomingOffer(session) {
    session.mode = 'yapp';
    const receiver = new YappReceiver({
      sendRawFn: (buf) => this.sendSessionRaw(session.id, buf),
      onOffer: ({ filename, totalBytes }) => this.emit('file-transfer-offer', { sessionId: session.id, filename, totalBytes }),
      onProgress: (p) => this.emit('file-transfer-progress', { sessionId: session.id, direction: 'receive', filename: receiver.filename, ...p }),
      onComplete: (data) => {
        const savePath = session._savePathForOffer;
        session._savePathForOffer = null;
        session.mode = 'text';
        session.yapp = null;
        try {
          if (savePath) fs.writeFileSync(savePath, data);
          if (this.sessionLogger) this.sessionLogger.appendNote(session, `received file ${receiver.filename} (${data.length} bytes)${savePath ? ` -> ${savePath}` : ''}`);
          this.emit('file-transfer-complete', { sessionId: session.id, direction: 'receive', filename: receiver.filename, savePath });
        } catch (e) {
          this.emit('file-transfer-error', { sessionId: session.id, direction: 'receive', filename: receiver.filename, message: e.message });
        }
      },
      onError: (e) => {
        session.mode = 'text'; session.yapp = null;
        this.emit('file-transfer-error', { sessionId: session.id, direction: 'receive', message: e.message });
      }
    });
    session.yapp = receiver;
    return receiver;
  }

  respondToFileOffer(sessionId, accept, savePath) {
    const session = this._findSession(sessionId);
    if (!session || !session.yapp) throw new Error('no file offer pending on this session');
    if (accept) {
      session._savePathForOffer = savePath;
      session.yapp.accept();
    } else {
      session.yapp.reject();
      session.mode = 'text';
      session.yapp = null;
    }
  }

  abortFileTransfer(sessionId) {
    const session = this._findSession(sessionId);
    if (!session || !session.yapp) return;
    session.yapp.abort();
    session.mode = 'text';
    session.yapp = null;
  }

  shutdown() {
    for (const session of Array.from(this.sessions.values())) {
      if (session.state === 'connected') {
        const t = this.tncs.get(session.tncId);
        const radio = t && t.config.radios.find((r) => r.id === session.radioId);
        if (t && radio) {
          const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control: CTL.DISC_P, pid: null, payload: Buffer.alloc(0), path: session.path });
          this._txAx25Frame(t, radio, frame);
        }
      }
      this._teardownConnected(session);
    }
    for (const tncId of this.tncs.keys()) this.disconnectTnc(tncId);
  }
}

module.exports = TncManager;
module.exports.classifyControl = classifyControl;
