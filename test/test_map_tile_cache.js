#!/usr/bin/env node
// Real end-to-end test of MapTileCache against a real local HTTP server
// standing in for tile.openstreetmap.org (never the real OSM servers —
// hitting those from an automated test would itself violate the tile
// usage policy this cache exists to respect). Covers: cache hits skip the
// network, conditional revalidation (304 keeps the old bytes, 200 replaces
// them), a network failure falls back to the stale cached tile instead of
// throwing, and budget-driven LRU eviction.
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const MapTileCache = require('../electron/main/maps/MapTileCache');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

// A controllable fake tile server: routes["/z/x/y.png"] = () => ({status, body, headers})
function startTileServer(routes) {
  const requestLog = [];
  const server = http.createServer((req, res) => {
    requestLog.push({ url: req.url, ifNoneMatch: req.headers['if-none-match'] });
    const handler = routes[req.url];
    if (!handler) { res.writeHead(404); res.end(); return; }
    const result = handler(req);
    if (result.status === 304) { res.writeHead(304, result.headers || {}); res.end(); return; }
    if (result.status >= 500) { res.writeHead(result.status); res.end(); return; }
    res.writeHead(result.status || 200, result.headers || {});
    res.end(result.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requestLog, port: server.address().port }));
  });
}

async function main() {
  await test('a cached tile is served from disk without hitting the network again', async () => {
    const { server, requestLog, port } = await startTileServer({
      '/5/10/12.png': () => ({ body: Buffer.from('tile-A'), headers: { 'content-type': 'image/png' } })
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}` });

    const first = await cache.getTile(5, 10, 12);
    assert.ok(first.data.equals(Buffer.from('tile-A')));
    const second = await cache.getTile(5, 10, 12);
    assert.ok(second.data.equals(Buffer.from('tile-A')));
    assert.strictEqual(requestLog.length, 1, `expected exactly one real HTTP request, got ${requestLog.length}`);

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('past the freshness window, a 304 revalidation keeps the existing cached bytes', async () => {
    let etag = '"v1"';
    const { server, requestLog, port } = await startTileServer({
      '/5/10/12.png': (req) => {
        if (req.headers['if-none-match'] === etag) return { status: 304 };
        return { body: Buffer.from('tile-A'), headers: { 'content-type': 'image/png', 'etag': etag, 'cache-control': 'max-age=0.05' } };
      }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}` });

    const first = await cache.getTile(5, 10, 12);
    assert.ok(first.data.equals(Buffer.from('tile-A')));
    await wait(120); // past the 50ms max-age
    const second = await cache.getTile(5, 10, 12);
    assert.ok(second.data.equals(Buffer.from('tile-A')), 'a 304 should still resolve with the previously-cached bytes');
    assert.strictEqual(requestLog.length, 2, `expected exactly 2 requests (initial + one revalidation), got ${requestLog.length}`);
    assert.strictEqual(requestLog[1].ifNoneMatch, etag, 'the revalidation request should carry If-None-Match with the stored ETag');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('a 200 on revalidation replaces the cached tile with the new content', async () => {
    let version = 1;
    const { server, port } = await startTileServer({
      '/5/10/12.png': () => {
        const body = Buffer.from(`tile-v${version}`);
        return { body, headers: { 'content-type': 'image/png', 'etag': `"v${version}"`, 'cache-control': 'max-age=0.05' } };
      }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}` });

    const first = await cache.getTile(5, 10, 12);
    assert.ok(first.data.equals(Buffer.from('tile-v1')));
    await wait(120);
    version = 2; // OpenStreetMap "updated" this tile
    const second = await cache.getTile(5, 10, 12);
    assert.ok(second.data.equals(Buffer.from('tile-v2')), `expected the updated tile content, got: ${second.data.toString()}`);

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('a network failure during revalidation falls back to the stale cached tile instead of throwing', async () => {
    let fail500 = false;
    const { server, port } = await startTileServer({
      '/5/10/12.png': () => {
        if (fail500) return { status: 500 };
        return { body: Buffer.from('tile-A'), headers: { 'content-type': 'image/png', 'cache-control': 'max-age=0.05' } };
      }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}` });

    await cache.getTile(5, 10, 12);
    await wait(120);
    fail500 = true;
    const result = await cache.getTile(5, 10, 12);
    assert.ok(result.data.equals(Buffer.from('tile-A')), 'should fall back to the stale cached tile, not throw');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('the cache evicts least-recently-accessed tiles to stay within budget', async () => {
    const routes = {};
    for (const [z, x, y] of [[1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1]]) {
      routes[`/${z}/${x}/${y}.png`] = () => ({ body: Buffer.alloc(100, `${z}${x}${y}`), headers: { 'content-type': 'image/png' } });
    }
    const { server, port } = await startTileServer(routes);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}`, budgetBytes: 250 });

    await cache.getTile(1, 0, 0); // oldest
    await wait(5);
    await cache.getTile(1, 0, 1);
    await wait(5);
    await cache.getTile(1, 1, 0);
    await wait(5);
    // 3 tiles * 100 bytes = 300 > 250 budget, so the oldest (0,0) should be evicted
    const info = cache.getCacheInfo();
    assert.ok(info.totalBytes <= 250, `total bytes should stay within budget, got ${info.totalBytes}`);
    assert.strictEqual(info.tileCount, 2, `expected the oldest tile to be evicted, got ${info.tileCount} tiles`);
    assert.ok(!fs.existsSync(path.join(dir, 'mapTiles', 'tiles', '1', '0', '0.png')), 'the evicted tile file should be deleted from disk');
    assert.ok(fs.existsSync(path.join(dir, 'mapTiles', 'tiles', '1', '1', '0.png')), 'the most recently accessed tile should survive');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('lowering the budget via setBudget() evicts immediately', async () => {
    const routes = {};
    for (const [z, x, y] of [[1, 0, 0], [1, 0, 1]]) {
      routes[`/${z}/${x}/${y}.png`] = () => ({ body: Buffer.alloc(100), headers: { 'content-type': 'image/png' } });
    }
    const { server, port } = await startTileServer(routes);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}`, budgetBytes: 1000 });

    await cache.getTile(1, 0, 0);
    await cache.getTile(1, 0, 1);
    assert.strictEqual(cache.getCacheInfo().tileCount, 2);

    cache.setBudget(100);
    const info = cache.getCacheInfo();
    assert.ok(info.totalBytes <= 100, `expected eviction down to the new budget, got ${info.totalBytes} bytes`);
    assert.strictEqual(info.tileCount, 1);

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('clear() removes every cached tile from disk and the index', async () => {
    const { server, port } = await startTileServer({
      '/1/0/0.png': () => ({ body: Buffer.from('x'), headers: { 'content-type': 'image/png' } })
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-tilecache-'));
    const cache = new MapTileCache({ userDataDir: dir, tileBaseUrl: `http://127.0.0.1:${port}` });

    await cache.getTile(1, 0, 0);
    assert.strictEqual(cache.getCacheInfo().tileCount, 1);
    cache.clear();
    const info = cache.getCacheInfo();
    assert.strictEqual(info.tileCount, 0);
    assert.strictEqual(info.totalBytes, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'mapTiles', 'tiles', '1', '0', '0.png')));

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
