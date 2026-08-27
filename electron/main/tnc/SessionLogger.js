const fs = require('fs');
const path = require('path');

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Persists connected-mode session transcripts to disk, one file per
// connect, under <userDataDir>/logs. Purely a persistence layer — viewing
// still happens live in SessionPane, this just makes it durable.
class SessionLogger {
  constructor({ userDataDir }) {
    this.logsDir = path.join(userDataDir, 'logs');
    this.streams = new Map(); // sessionId -> {stream, path}
  }

  startLog(session) {
    if (this.streams.has(session.id)) return;
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      const filePath = path.join(this.logsDir, `${session.remoteCall}_${timestamp(new Date())}.log`);
      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.streams.set(session.id, { stream, path: filePath });
      session.logPath = filePath;
    } catch (e) { /* logging is best-effort, never block a session over it */ }
  }

  appendLog(session, direction, text) {
    const entry = this.streams.get(session.id);
    if (!entry) return;
    const marker = direction === 'tx' ? 'TX>' : direction === 'rx' ? 'RX<' : direction;
    entry.stream.write(`[${new Date().toLocaleTimeString()}] ${marker} ${text}\n`);
  }

  appendNote(session, note) {
    const entry = this.streams.get(session.id);
    if (!entry) return;
    entry.stream.write(`[${new Date().toLocaleTimeString()}] *** ${note}\n`);
  }

  stopLog(session) {
    const entry = this.streams.get(session.id);
    if (!entry) return;
    entry.stream.end();
    this.streams.delete(session.id);
  }
}

module.exports = SessionLogger;
