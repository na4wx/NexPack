const https = require('https');

// Checks GitHub Releases directly (the REST API's "latest release" endpoint)
// rather than using electron-updater's full auto-download machinery.
// electron-updater needs its own metadata files (latest.yml/latest-mac.yml)
// published alongside each release, which only happens automatically when
// electron-builder itself publishes the release (`--publish=always`) — this
// project's releases so far were created by hand with `gh release create`,
// so those files don't exist yet. This works against exactly what's already
// there today: fetch the latest tag, compare versions, and if newer, let the
// user open the release page to grab the installer themselves. Switching to
// full in-app download-and-install later is a real option, but it's a
// bigger change to the release process than "add an update check" calls for.
const REPO = 'na4wx/NexPack';

// Plain X.Y.Z numeric comparison — good enough for this project's versioning
// (see package.json/CHANGELOG bumps), no need for a full semver dependency.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

class UpdateChecker {
  constructor({ currentVersion }) {
    this.currentVersion = currentVersion;
  }

  async checkForUpdate() {
    const release = await this._fetchLatestRelease();
    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    return {
      updateAvailable: latestVersion ? compareVersions(latestVersion, this.currentVersion) > 0 : false,
      currentVersion: this.currentVersion,
      latestVersion: latestVersion || null,
      releaseUrl: release.html_url || `https://github.com/${REPO}/releases/latest`,
      releaseNotes: release.body || '',
      publishedAt: release.published_at || null
    };
  }

  _fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        headers: { 'User-Agent': 'NexPack-UpdateChecker', Accept: 'application/vnd.github+json' },
        timeout: 8000
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(res.statusCode === 404 ? 'No releases published yet.' : `GitHub returned ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Could not parse GitHub\'s response.')); }
        });
      });
      req.on('error', (e) => reject(new Error(`Could not reach GitHub: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Timed out contacting GitHub.')); });
    });
  }
}

module.exports = UpdateChecker;
module.exports.compareVersions = compareVersions;
