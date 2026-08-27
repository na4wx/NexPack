const fs = require('fs');
const path = require('path');

// Real RF client for the NexDigi BBS's text-command protocol
// (server/lib/bbsSession.js in the NexDigi repo) — connects over a plain
// AX.25 connected-mode session (reusing TncManager, same as Terminal) and
// drives the same L/P/R/M/BYE commands a human would type, parsing the
// server's text replies back into structured message records matching the
// shape NexDigiClient's HTTP JSON already produces (best-effort — RF list
// output has no message content and only date-granularity timestamps).
const CONNECT_TIMEOUT_MS = 25000;
const COMMAND_TIMEOUT_MS = 25000;
const QUIET_PERIOD_MS = 500;
const DEFAULTS = { tncId: null, radioId: null, bbsCallsign: '', digiPath: [] };

function parseDate(dateStr) {
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? null : t;
}

class RfBbsClient {
  constructor({ userDataDir, tncManager }) {
    this.configPath = path.join(userDataDir, 'rf-bbs.json');
    this.tncManager = tncManager;
    this._queue = Promise.resolve();
  }

  // ---- settings ----
  getSettings() {
    if (!fs.existsSync(this.configPath)) return { ...DEFAULTS };
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) }; } catch (e) { return { ...DEFAULTS }; }
  }

  saveSettings(settings) {
    const merged = { ...this.getSettings(), ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  // ---- concurrency: every public RF operation runs one at a time ----
  // (BbsMail.jsx's refresh() does Promise.all([listMessages, listBulletins]);
  // without this, both would call tncManager.startSession concurrently with
  // the identical sessionKey and silently clobber each other's session.)
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  // ---- public API (mirrors NexDigiClient's shape) ----
  listBulletins() {
    return this._enqueue(() => this._session(async (session) => {
      const reply = await session.sendAndWait('L', { terminators: ['CMD (H = Help)', 'No bulletin messages available.'] });
      return this._parseBulletins(reply);
    }));
  }

  listMessages(filters) {
    if (filters && Object.keys(filters).length) console.warn('RfBbsClient.listMessages: filters are not supported over RF and were ignored', filters);
    return this._enqueue(() => this._session(async (session) => {
      const reply = await session.sendAndWait('P', { terminators: ['CMD (H = Help)', /No personal messages for .*\*\.$/m] });
      return this._parsePersonal(reply);
    }));
  }

  markRead(messageNumber) {
    return this._enqueue(() => this._session(async (session) => {
      const reply = await session.sendAndWait(`R ${messageNumber}`, { terminators: ['Enter - Return to main menu', 'CMD (H = Help)'] });
      if (/not found/i.test(reply)) throw new Error(`Message ${messageNumber} not found`);
      const parsed = this._parseReadMessage(reply, messageNumber);
      // Exit post-read state before the caller's session teardown sends BYE —
      // BYE sent while still in post-read is silently swallowed as "return
      // to menu" input, not a sign-off.
      await session.sendAndWait('', { terminators: ['CMD (H = Help)'] });
      return parsed;
    }));
  }

  deleteMessage(messageNumber) {
    return this._enqueue(() => this._session(async (session) => {
      await session.sendAndWait(`R ${messageNumber}`, { terminators: ['Enter - Return to main menu', 'CMD (H = Help)'] });
      const reply = await session.sendAndWait('D', { terminators: ['CMD (H = Help)'] });
      if (/error deleting/i.test(reply)) throw new Error(`Failed to delete message ${messageNumber}`);
      return { success: true };
    }));
  }

  postMessage({ recipient, content }) {
    return this._enqueue(() => this._session(async (session) => {
      if (!recipient) throw new Error('recipient is required');
      await session.sendAndWait(`M ${recipient}`, { terminators: ['Enter message (end with . on new line):'] });
      const lines = String(content || '').split(/\r?\n/);
      for (const line of lines) session.send(line); // no wait between body lines — server just appends silently
      const reply = await session.sendAndWait('.', { terminators: ['CMD (H = Help)'] });
      if (/cancelled \(empty\)/i.test(reply)) throw new Error('Message was empty, not sent');
      const m = reply.match(/stored as #(\d+)/);
      return {
        messageNumber: m ? Number(m[1]) : null,
        recipient: String(recipient).toUpperCase(),
        sender: session.ownCallsign,
        subject: 'BBS Message', // fixed server-side for M-composed messages — no RF path can set a custom subject
        category: 'P',
        priority: 'N',
        content,
        timestamp: Date.now()
      };
    }));
  }

  getStats() {
    return Promise.reject(new Error('Message counts are not available over RF — connect via HTTP for BBS stats.'));
  }

  // ---- session lifecycle ----
  _session(fn) {
    return new Promise((resolve, reject) => {
      (async () => {
        const settings = this.getSettings();
        if (!settings.tncId || !settings.radioId || !settings.bbsCallsign) {
          reject(new Error('RF BBS is not configured — set a TNC/radio and BBS callsign in Radio settings.'));
          return;
        }

        let sessionId = null;
        let buffer = '';
        let lastChunkAt = 0;
        const onData = (evt) => {
          if (evt.sessionId !== sessionId) return;
          buffer += evt.text;
          lastChunkAt = Date.now();
        };

        const waitFor = (terminators, timeoutMs = COMMAND_TIMEOUT_MS) => new Promise((res, rej) => {
          const start = Date.now();
          const check = () => {
            const matched = terminators.some((t) => (t instanceof RegExp ? t.test(buffer) : buffer.includes(t)));
            if (matched) { const out = buffer; buffer = ''; res(out); return; }
            if (Date.now() - start > timeoutMs) { rej(new Error(`Timed out waiting for a reply from ${settings.bbsCallsign}.`)); return; }
            if (lastChunkAt && buffer.length > 0 && Date.now() - lastChunkAt > QUIET_PERIOD_MS) { const out = buffer; buffer = ''; res(out); return; }
            setTimeout(check, 100);
          };
          check();
        });

        try {
          const tncs = this.tncManager.listTncs();
          const tnc = tncs.find((t) => t.id === settings.tncId);
          const radio = tnc && tnc.radios.find((r) => r.id === settings.radioId);
          if (!tnc || !radio) throw new Error('The configured TNC/radio for RF BBS no longer exists — check Radio settings.');

          const snap = this.tncManager.startSession(settings.tncId, settings.radioId, settings.bbsCallsign, settings.digiPath || []);
          sessionId = snap.id;
          this.tncManager.on('session-data', onData);

          await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`Timed out connecting to ${settings.bbsCallsign} over RF.`)), CONNECT_TIMEOUT_MS);
            const onState = (s) => {
              if (s.id !== sessionId) return;
              if (s.state === 'connected') { clearTimeout(timer); this.tncManager.removeListener('session-state', onState); res(); }
              else if (s.state === 'disconnected') { clearTimeout(timer); this.tncManager.removeListener('session-state', onState); rej(new Error(`Connection to ${settings.bbsCallsign} was refused or dropped.`)); }
            };
            this.tncManager.on('session-state', onState);
          });

          const banner = await waitFor(['CMD (H = Help)', 'Enter your Name:', 'Enter your QTH']);
          if (/Enter your Name:|Enter your QTH/.test(banner)) {
            throw new Error(`${settings.bbsCallsign} is asking ${radio.callsign} to set up an account (name/QTH) — connect once via Terminal to complete it before using RF BBS here.`);
          }

          const sessionApi = {
            ownCallsign: radio.callsign,
            send: (text) => this.tncManager.sendSessionText(sessionId, text),
            sendAndWait: async (text, opts = {}) => {
              if (text !== undefined) this.tncManager.sendSessionText(sessionId, text);
              return waitFor(opts.terminators || ['CMD (H = Help)'], opts.timeoutMs);
            }
          };

          const result = await fn(sessionApi);

          // Best-effort sign-off — a missed 'disconnected' event shouldn't
          // fail an otherwise-successful operation.
          try {
            this.tncManager.sendSessionText(sessionId, 'BYE');
            await new Promise((res) => {
              const timer = setTimeout(res, 3000);
              const onState = (s) => { if (s.id === sessionId && s.state === 'disconnected') { clearTimeout(timer); this.tncManager.removeListener('session-state', onState); res(); } };
              this.tncManager.on('session-state', onState);
            });
          } catch (e) { /* ignore — teardown below still runs */ }

          this.tncManager.removeListener('session-data', onData);
          try { this.tncManager.endSession(sessionId); } catch (e) { /* already gone */ }
          resolve(result);
        } catch (e) {
          this.tncManager.removeListener('session-data', onData);
          if (sessionId) { try { this.tncManager.endSession(sessionId); } catch (e2) { /* ignore */ } }
          reject(e);
        }
      })();
    });
  }

  // ---- text-response parsing (formats verified against NexDigi's bbsSession.js) ----
  _parseBulletins(text) {
    const results = [];
    const re = /^(\d+):\s+(.+?)\s+-\s+(.+?)\s+\(([\d/]+)\)$/;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) results.push({ messageNumber: Number(m[1]), sender: m[2], subject: m[3], category: 'B', timestamp: parseDate(m[4]), content: null, read: true });
    }
    return results;
  }

  _parsePersonal(text) {
    const results = [];
    const re = /^(\d+):\s+To\s+(\S+)\s+From\s+(\S+)\s+-\s+(.+?)\s+\(([\d/]+)\)\s+\[(READ|NEW)\]$/;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) results.push({ messageNumber: Number(m[1]), recipient: m[2], sender: m[3], subject: m[4], timestamp: parseDate(m[5]), read: m[6] === 'READ', content: null, category: 'P' });
    }
    return results;
  }

  _parseReadMessage(text, messageNumber) {
    const fromMatch = text.match(/From:\s*(.+)/);
    const dateMatch = text.match(/Date:\s*(.+)/);
    const subjectMatch = text.match(/Subject:\s*(.+)/);
    const contentMatch = text.match(/Subject:.*\r?\n\r?\n([\s\S]*?)\r?\n\r?\nOptions:/);
    return {
      messageNumber,
      sender: fromMatch ? fromMatch[1].trim() : null,
      recipient: null, // R n's reply has no "To:" line — recipient is implicit (the connecting station)
      subject: subjectMatch ? subjectMatch[1].trim() : null,
      timestamp: dateMatch ? parseDate(dateMatch[1].trim()) : null,
      content: contentMatch ? contentMatch[1].replace(/\r\n/g, '\n').trim() : '',
      read: true
      // No `category` key here on purpose — R n's reply doesn't say whether
      // this was a bulletin or personal message (both are readable via R n),
      // so callers should preserve whatever category the list entry already had.
    };
  }
}

module.exports = RfBbsClient;
