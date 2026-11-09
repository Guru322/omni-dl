/**
 * Downloads the platform-matching yt-dlp standalone binary into ./bin/
 * Runs on npm install (postinstall) so any PaaS container gets it fresh.
 * Idempotent; skips if already present or network blocked (server falls
 * back to PATH / pip variants at boot).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const BIN = path.join(__dirname, '..', 'bin');

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

function artifactFor(platform) {
  switch (platform) {
    case 'linux': return { name: 'yt-dlp_linux', url: `${RELEASES}/yt-dlp_linux` };
    case 'darwin': return { name: 'yt-dlp_macos', url: `${RELEASES}/yt-dlp_macos` };
    default: return null; // windows/other: rely on PATH or pip
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (url, redirects = 0) => {
      https.get(url, { headers: { 'User-Agent': 'media-download-api' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return go(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
        const out = fs.createWriteStream(dest, { mode: 0o755 });
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
      }).on('error', reject);
    };
    go(url);
  });
}

(async () => {
  const target = path.join(BIN, 'yt-dlp');
  try {
    fs.mkdirSync(BIN, { recursive: true });
    if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) {
      console.log('[install-ytdlp] already present:', target);
      return;
    }
    const art = artifactFor(os.platform());
    if (!art) { console.log('[install-ytdlp] no fixed binary for this platform; server will fall back to PATH'); return; }
    process.stdout.write(`[install-ytdlp] downloading ${art.name}... `);
    await download(art.url, target);
    fs.chmodSync(target, 0o755);
    console.log('done →', target, `(${(fs.statSync(target).size / 1048576).toFixed(0)} MB)`);
  } catch (err) {
    console.error('[install-ytdlp] failed (non-fatal):', err.message);
    try { fs.unlinkSync(target); } catch { }
  }
})();
