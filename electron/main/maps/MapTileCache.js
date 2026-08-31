const fs = require('fs');
const path = require('path');

// Persistent OSM tile cache — deliberately NOT a "download a city/state"
// bulk pre-fetcher. OSM's tile usage policy (operations.osmfoundation.org/
// policies/tiles/) explicitly prohibits pre-seeding areas, building tile
// archives, and any "offline use" built on prefetching tiles.openstreetmap.org
// — but it *requires* honoring HTTP caching headers and caching what's
// actually viewed ("cache tiles locally according to HTTP caching headers,
// or at least 7 days if your cache cannot read them"). This only ever
// caches a tile in response to it actually being requested for display, and
// treats a cached tile as good indefinitely until either the local budget
// forces eviction or a conditional revalidation confirms OSM changed it —
// "permanently cached unless OpenStreetMap updates it," as requested.
const DEFAULT_BUDGET_BYTES = 1024 * 1024 * 1024; // 1GB
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // OSM policy's own fallback figure
const DEFAULT_TILE_BASE_URL = 'https://tile.openstreetmap.org'; // one fixed host, not {s}-sharded — we're not browser-connection-limited
const USER_AGENT = 'NexPack (https://github.com/na4wx/NexPack)';

class MapTileCache {
  constructor({ userDataDir, budgetBytes, tileBaseUrl }) {
    this.dir = path.join(userDataDir, 'mapTiles');
    this.tilesDir = path.join(this.dir, 'tiles');
    this.indexPath = path.join(this.dir, 'index.json');
    this.settingsPath = path.join(this.dir, 'settings.json');
    fs.mkdirSync(this.tilesDir, { recursive: true });

    // Overridable only for tests, which must never hit the real OSM
    // servers — that would itself violate the very tile usage policy this
    // cache exists to respect.
    this.tileBaseUrl = tileBaseUrl || DEFAULT_TILE_BASE_URL;
    this.budgetBytes = budgetBytes || this._loadBudget() || DEFAULT_BUDGET_BYTES;
    this.index = this._loadIndex(); // "z/x/y" -> { size, etag, lastModified, maxAgeMs, cachedAt, lastAccessed }
    this.totalBytes = Object.values(this.index).reduce((sum, e) => sum + e.size, 0);
    this._inflight = new Map(); // "z/x/y" -> Promise, de-dupes concurrent requests for the same tile
    this._indexDirty = false;
    this._indexSaveTimer = null;
  }

  _loadIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch (e) { return {}; }
  }

  _loadBudget() {
    try { return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')).budgetBytes; } catch (e) { return null; }
  }

  _saveSettings() {
    try { fs.writeFileSync(this.settingsPath, JSON.stringify({ budgetBytes: this.budgetBytes }, null, 2)); } catch (e) { /* ignore */ }
  }

  // Batches index writes rather than doing a full JSON rewrite on every
  // single tile fetch — this can be a very hot path during normal panning.
  _scheduleIndexSave() {
    this._indexDirty = true;
    if (this._indexSaveTimer) return;
    this._indexSaveTimer = setTimeout(() => {
      this._indexSaveTimer = null;
      if (!this._indexDirty) return;
      this._indexDirty = false;
      try { fs.writeFileSync(this.indexPath, JSON.stringify(this.index)); } catch (e) { /* ignore */ }
    }, 2000);
  }

  _tilePath(z, x, y) {
    return path.join(this.tilesDir, String(z), String(x), `${y}.png`);
  }

  getCacheInfo() {
    return { totalBytes: this.totalBytes, budgetBytes: this.budgetBytes, tileCount: Object.keys(this.index).length };
  }

  setBudget(budgetBytes) {
    this.budgetBytes = Math.max(0, Number(budgetBytes) || 0);
    this._saveSettings();
    this._evictIfOverBudget();
    return this.budgetBytes;
  }

  clear() {
    if (this._indexSaveTimer) clearTimeout(this._indexSaveTimer);
    this._indexSaveTimer = null;
    this._indexDirty = false;
    try { fs.rmSync(this.tilesDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(this.tilesDir, { recursive: true });
    this.index = {};
    this.totalBytes = 0;
    try { fs.writeFileSync(this.indexPath, JSON.stringify(this.index)); } catch (e) { /* ignore */ }
  }

  // Least-recently-*viewed* eviction, not least-recently-fetched — a tile
  // that's still being looked at regularly should survive over one nobody
  // has scrolled past in months, even if it happens to update less often.
  _evictIfOverBudget() {
    if (this.totalBytes <= this.budgetBytes) return;
    const entries = Object.entries(this.index).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    for (const [key, entry] of entries) {
      if (this.totalBytes <= this.budgetBytes) break;
      try { fs.unlinkSync(this._tileFilePathFromKey(key)); } catch (e) { /* already gone */ }
      delete this.index[key];
      this.totalBytes -= entry.size;
    }
    this._scheduleIndexSave();
  }

  _tileFilePathFromKey(key) {
    const [z, x, y] = key.split('/');
    return this._tilePath(z, x, y);
  }

  _parseMaxAgeMs(cacheControlHeader) {
    if (!cacheControlHeader) return null;
    const m = /max-age=(\d+(?:\.\d+)?)/i.exec(cacheControlHeader);
    return m ? Number(m[1]) * 1000 : null;
  }

  // Returns { data: Buffer, contentType }. Never throws for "OSM
  // unreachable" — falls back to a stale cached tile if one exists, since a
  // slightly outdated tile beats a broken map tile for an app whose whole
  // point is working over unreliable RF-adjacent connectivity.
  async getTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const promise = this._getTileUncached(key, z, x, y).finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  async _getTileUncached(key, z, x, y) {
    const entry = this.index[key];
    const filePath = this._tilePath(z, x, y);
    const cachedBytes = entry && fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;

    if (entry && cachedBytes) {
      const age = Date.now() - entry.cachedAt;
      // entry.maxAgeMs can legitimately be 0 (Cache-Control: max-age=0 means
      // "always revalidate") — `||` would treat that as "not set" and wrongly
      // fall back to the 7-day default, so this has to be a null check.
      const maxAge = entry.maxAgeMs != null ? entry.maxAgeMs : DEFAULT_MAX_AGE_MS;
      if (age < maxAge) {
        entry.lastAccessed = Date.now();
        this._scheduleIndexSave();
        return { data: cachedBytes, contentType: 'image/png' };
      }
      // Past the freshness window — revalidate rather than assume stale.
      // A 304 means OSM hasn't changed it, so it's re-cached as fresh
      // ("permanently cached unless OpenStreetMap updates it").
      try {
        const revalidated = await this._fetchTile(z, x, y, entry);
        if (revalidated.notModified) {
          entry.cachedAt = Date.now();
          entry.lastAccessed = Date.now();
          this._scheduleIndexSave();
          return { data: cachedBytes, contentType: 'image/png' };
        }
        this._storeTile(key, z, x, y, revalidated.data, revalidated.etag, revalidated.lastModified, revalidated.maxAgeMs);
        return { data: revalidated.data, contentType: 'image/png' };
      } catch (e) {
        // Offline or OSM unreachable — the stale tile is still better than
        // nothing. Leave cachedAt alone so the next successful check retries.
        entry.lastAccessed = Date.now();
        this._scheduleIndexSave();
        return { data: cachedBytes, contentType: 'image/png' };
      }
    }

    // Never seen this tile before.
    const fetched = await this._fetchTile(z, x, y, null);
    this._storeTile(key, z, x, y, fetched.data, fetched.etag, fetched.lastModified, fetched.maxAgeMs);
    return { data: fetched.data, contentType: 'image/png' };
  }

  _storeTile(key, z, x, y, data, etag, lastModified, maxAgeMs) {
    const filePath = this._tilePath(z, x, y);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    const prevSize = this.index[key] ? this.index[key].size : 0;
    this.index[key] = { size: data.length, etag: etag || null, lastModified: lastModified || null, maxAgeMs: maxAgeMs != null ? maxAgeMs : null, cachedAt: Date.now(), lastAccessed: Date.now() };
    this.totalBytes += data.length - prevSize;
    this._scheduleIndexSave();
    this._evictIfOverBudget();
  }

  async _fetchTile(z, x, y, existingEntry) {
    const url = `${this.tileBaseUrl}/${z}/${x}/${y}.png`;
    const headers = { 'User-Agent': USER_AGENT };
    if (existingEntry && existingEntry.etag) headers['If-None-Match'] = existingEntry.etag;
    if (existingEntry && existingEntry.lastModified) headers['If-Modified-Since'] = existingEntry.lastModified;
    const res = await fetch(url, { headers });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`tile fetch failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    return {
      data,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      maxAgeMs: this._parseMaxAgeMs(res.headers.get('cache-control'))
    };
  }
}

module.exports = MapTileCache;
