/**
 * Media Download API — Express wrapper around yt-dlp + ffmpeg.
 *
 * Supports ~1,800 sites (everything yt-dlp supports): YouTube, Instagram,
 * TikTok, X/Twitter, Reddit, SoundCloud, Bandcamp, ...
 *
 * Env vars:
 *   PORT             default 3000
 *   API_KEY          if set, all requests must send "x-api-key: <key>"
 *   COOKIES_FILE     path to a Netscape-format cookies.txt for auth-only content
 *   MAX_CONCURRENT   max simultaneous yt-dlp downloads (default 3)
 *   CLEANUP_MINUTES  auto-delete finished jobs' files after N minutes (0 = off, default 60)
 *   PUBLIC_BASE      e.g. https://api.gurusensei.dev — domain used in generated
 *                    proxy links from /api/media (empty = relative URLs)
 *   LINK_TTL         seconds to reuse resolved CDN links before re-extract (default 300)
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline: streamPipeline } = require('stream/promises');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const CLEANUP_MINUTES = parseInt(process.env.CLEANUP_MINUTES || '60', 10);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
const LINK_TTL = parseInt(process.env.LINK_TTL || '300', 10) * 1000;

/* --- toolchain resolution (works on bare PaaS containers) ------------------- */
const { spawnSync } = require('child_process');
const os = require('os');

const runnable = (cmd) => {
  try { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
};

function pickYtdlp() {
  const cands = [
    process.env.YTDLP_PATH,
    path.join(__dirname, 'bin', 'yt-dlp'),           // dropped by scripts/install-ytdlp.js
    'yt-dlp',                                        // PATH
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
  ].filter(Boolean);
  for (const c of cands) if (runnable(c)) return c;
  return 'yt-dlp'; // last resort; will fail loudly per-request
}

function pickFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static');              // static binary from npm
    if (p && fs.existsSync(p)) return p;
  } catch { }
  return runnable('ffmpeg') ? 'ffmpeg' : null;
}

const YTDLP = pickYtdlp();
const FFMPEG_PATH = pickFfmpeg();

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------- auth ---------------------------------- */

app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.header('x-api-key') === API_KEY) return next();
  res.status(401).json({ error: 'Invalid or missing x-api-key header' });
});

/* ------------------------------- job registry ------------------------------ */

/**
 * job = {
 *   id, url, status: 'queued'|'processing'|'downloading'|'merging'|'done'|'error'|'cancelled',
 *   progress (0-100), speed, eta, filePath, fileSize, info, error, createdAt, finishedAt
 * }
 */
const jobs = new Map();
let running = 0;
const queue = []; // FIFO of { job }

function pushQueue(job) {
  queue.push(job);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    running++;
    runDownload(job).finally(() => {
      running--;
      pump();
    });
  }
}

function setJob(job, patch) {
  Object.assign(job, patch);
}

function snapshot(job) {
  const { proc, ...safe } = job;
  return safe;
}

/* ------------------------------- yt-dlp runner ------------------------------ */

function validUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function baseArgs(extra = []) {
  const args = [
    '--no-warnings', '--no-progress', '--no-color',
    ...extra,
  ];
  if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
  if (FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG_PATH);
  return args;
}

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

/* Extract metadata + formats without downloading. */
async function fetchInfo(url) {
  const raw = await runYtdlp(baseArgs(['-J', '--no-playlist', url]));
  return JSON.parse(raw);
}

function listFormats(info) {
  return (info.formats || [])
    .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
    .map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : 'audio only'),
      fps: f.fps || null,
      vcodec: f.vcodec,
      acodec: f.acodec,
      filesize: f.filesize || f.filesize_approx || null,
      tbr: f.tbr || null,
      protocol: f.protocol || null,
      note: f.format_note || null,
      /* Direct CDN/stream URL — playable with the player of your choice.
         Caveats: many CDNs sign URLs (expire in hours, sometimes IP-locked),
         m3u8/dash are manifests (need an HLS/DASH player), and video-only
         streams have no audio (combine with a bestaudio url client-side). */
      url: f.url ?? null,
    }));
}

/** Common yt-dlp format selection for a preset. Returns [] of args. */
function formatArgs({ format = 'mp4', quality = 'best' } = {}) {
  const h = quality === 'best' ? '' : `[height<=${quality}]`;
  switch (format) {
    case 'mp4':
      return ['-f', `bv*[ext=mp4]${h}+ba[ext=m4a]/b${h.replace('height', 'best[height]')}/bv*+ba/b`,
              '--merge-output-format', 'mp4'];
    case 'webm':
      return ['-f', `bv*[ext=webm]${h}+bestaudio/b${h}/bv*+ba/b`,
              '--merge-output-format', 'webm'];
    case 'mp3':
      return ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    case 'm4a':
      return ['-f', `bestaudio[ext=m4a]${h === '' ? '' : ''}/bestaudio`, '-x', '--audio-format', 'm4a'];
    case 'audio':
      return ['-f', 'bestaudio', '-x', '--audio-format', 'opus'];
    default:
      throw new Error(`unsupported format "${format}" (use mp4 | webm | mp3 | m4a | audio)`);
  }
}

/* Download with progress streaming. */
function runDownload(job) {
  return new Promise((resolve) => {
    const finish = () => resolve();

    let args;
    try {
      args = formatArgs(job.options);
    } catch (err) {
      jobs.delete(job.id); // unsupported format — drop the job
      setJob(job, { status: 'error', error: err.message, finishedAt: Date.now() });
      return finish();
    }

    const outputTemplate = path.join(DOWNLOADS_DIR, job.id);
    const proc = spawn(YTDLP, baseArgs([
      '--no-playlist',
      '--newline',
      '--no-simulate',
      '--print', 'after_move:filepath',
      '-P', DOWNLOADS_DIR,
      '-o', `${job.id}.%(ext)s`,
      ...args,
      job.url,
    ]));

    setJob(job, { status: 'downloading', proc });

    let lastLinePath = null;

    const onLine = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/[\r\n]+/)) {
        const m = line.match(/\[+(download|Merger|ExtractAudio)\]+.*?([\d.]+)%/);
        if (m) {
          const pct = parseFloat(m[2]);
          const speed = line.match(/at\s+([\d.]+\w+\/s)/);
          const eta = line.match(/ETA\s+([\d:]+)/);
          setJob(job, {
            progress: pct,
            ...(speed && { speed: speed[1] }),
            ...(eta && { eta: eta[1] }),
            status: m[1] === 'download' ? 'downloading' : 'merging',
          });
        } else if (path.isAbsolute(line.trim()) && fs.existsSync(line.trim())) {
          lastLinePath = line.trim();
        }
      }
    };

    proc.stdout.on('data', onLine);
    proc.stderr.on('data', (d) => {
      if (!job.errorDetail) job.errorDetail = d.toString().trim().slice(0, 2000);
    });
    proc.on('error', (err) => {
      setJob(job, { status: 'error', error: `spawn failed: ${err.message}`, finishedAt: Date.now() });
      finish();
    });
    proc.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || job.status === 'cancelled') {
        setJob(job, { status: 'cancelled', finishedAt: Date.now() });
        return finish();
      }
      if (code === 0 && lastLinePath) {
        let fileSize = null;
        try { fileSize = fs.statSync(lastLinePath).size; } catch { }
        setJob(job, {
          status: 'done', progress: 100, filePath: lastLinePath,
          fileSize, finishedAt: Date.now(),
        });
      } else if (code === 0) {
        // file printed wasn't stat-able; try to find it
        const exts = ['mp4', 'webm', 'mp3', 'm4a', 'opus', 'mkv', 'ogg'];
        const found = exts
          .map((e) => `${outputTemplate}.${e}`)
          .find((p) => fs.existsSync(p));
        if (found) {
          setJob(job, {
            status: 'done', progress: 100, filePath: found,
            fileSize: fs.statSync(found).size, finishedAt: Date.now(),
          });
        } else {
          setJob(job, { status: 'error', error: job.errorDetail || 'download finished but file not found', finishedAt: Date.now() });
        }
      } else {
        setJob(job, { status: 'error', error: job.errorDetail || `yt-dlp exited with code ${code}`, finishedAt: Date.now() });
      }
      job.info && Object.assign(snapshot(job), {});
      finish();
    });
  });
}

/* ------------------------------ auto cleanup ------------------------------- */

function scheduleCleanup(job) {
  if (CLEANUP_MINUTES <= 0) return;
  setTimeout(() => {
    if (job.filePath && fs.existsSync(job.filePath)) {
      try { fs.unlinkSync(job.filePath); } catch { }
    }
    if (['done', 'error', 'cancelled'].includes(job.status)) jobs.delete(job.id);
  }, CLEANUP_MINUTES * 60 * 1000).unref();
}

/* ---------------------------------- routes --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    queueDepth: queue.length,
    running,
    active: jobs.size,
  });
});

/* Metadata & formats for any URL. */
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !validUrl(url)) return res.status(400).json({ error: 'query ?url= must be a valid http(s) URL' });

  try {
    const info = await fetchInfo(url);
    res.json({
      id: info.id,
      title: info.title,
      extractor: info.extractor_key || info.extractor,
      duration: info.duration,
      duration_string: info.duration_string,
      thumbnail: info.thumbnail,
      upload_date: info.upload_date,
      uploader: info.uploader || info.channel,
      description: (info.description || '').slice(0, 500),
      formats: listFormats(info),
    });
  } catch (err) {
    res.status(502).json({ error: 'extraction failed', detail: err.message });
  }
});

/* Start a download job. Body: { url, format?, quality? } */
app.post('/api/download', async (req, res) => {
  const { url, format = 'mp4', quality = 'best' } = req.body || {};
  if (!url || !validUrl(url)) return res.status(400).json({ error: 'body url must be a valid http(s) URL' });

  try {
    // Validate preset early (before queueing).
    formatArgs({ format, quality });

    const job = {
      id: crypto.randomUUID(),
      url,
      options: { format, quality },
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };

    // Fetch metadata (for title/type in responses) — non-fatal on failure.
    runYtdlp(baseArgs(['-J', '--no-playlist', url]))
      .then((raw) => setJob(job, { info: { title: JSON.parse(raw).title, extractor: JSON.parse(raw).extractor_key } }))
      .catch(() => { });

    jobs.set(job.id, job);
    pushQueue(job);
    scheduleCleanup(job);

    res.status(202).json(snapshot(job));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* List all jobs. */
app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()].map(snapshot).sort((a, b) => b.createdAt - a.createdAt));
});

/* Job status. */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(snapshot(job));
});

/* Get the downloaded file binary. */
app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'done' || !job.filePath) {
    return res.status(409).json({ error: `file not ready (status: ${job.status}, progress: ${job.progress}%)` });
  }
  const ext = path.extname(job.filePath);
  const base = (job.info?.title || path.basename(job.filePath, ext))
    .replace(/[/\\:*?"<>|]/g, '_')
    .slice(0, 150);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base + ext)}`);
  const audioType = { mp3: 'audio/mpeg', m4a: 'audio/mp4', audio: 'audio/opus' };
  res.setHeader('Content-Type', audioType[job.options.format] || 'video/mp4');
  res.sendFile(job.filePath);
});

/* Cancel a running / remove a finished job and its file. */
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status === 'queued') {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    jobs.delete(job.id);
    return res.json({ ok: true, removed: true });
  }
  if (job.proc && !job.proc.killed) {
    job.status = 'cancelled';
    setJob(job, { status: 'cancelled' });
    job.proc.kill('SIGTERM');
    setTimeout(() => { try { job.proc.killed || job.proc.kill('SIGKILL'); } catch { } }, 5000).unref();
    return res.json({ ok: true, cancelled: true });
  }
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    if (job.filePath && fs.existsSync(job.filePath)) { try { fs.unlinkSync(job.filePath); } catch { } }
    jobs.delete(job.id);
    return res.json({ ok: true, removed: true });
  }
  res.json({ ok: true, status: job.status });
});

/* Update yt-dlp itself (extractors break often). */
app.post('/api/update-extractors', async (req, res) => {
  try {
    const out = await runYtdlp(['-U']);
    res.json({ ok: true, output: out.trim().split('\n').slice(-5) });
  } catch (err) {
    res.status(500).json({ ok: false, detail: err.message });
  }
});

/* ============================================================================ */
/*  CDN TUNNEL — /api/media : stream pieces of any platform through this domain  */
/* ============================================================================ */

/**
 * Resolved-link cache: platform url -> { ts, formats, hosts, title }
 * A single yt-dlp -J run yields fresh signed URLs for ALL formats, so every
 * /api/media/:formatId request is served from one shared extraction.
 */
const linkCache = new Map();
const inflight = new Map();

async function extractLinks(src) {
  const cached = linkCache.get(src);
  if (cached && Date.now() - cached.ts < LINK_TTL) return cached;

  if (inflight.has(src)) return inflight.get(src); // stampede guard
  const p = (async () => {
    const info = await fetchInfo(src);
    const formats = (info.formats || [])
      .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
      .map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || null,
        protocol: f.protocol || '',
        url: f.url || null,
        headers: f.http_headers || {},
      }));
    if (!formats.length) throw new Error('no formats found');
    const hosts = new Set(
      formats
        .filter((f) => f.url)
        .map((f) => { try { return new URL(f.url).host; } catch { return null; } })
        .filter(Boolean)
    );
    const entry = { ts: Date.now(), formats, hosts, title: info.title };
    linkCache.set(src, entry);
    // keep cache small: 100 sources max
    if (linkCache.size > 100) {
      const oldest = [...linkCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) linkCache.delete(oldest[0]);
    }
    return entry;
  })()
    .catch((err) => { throw err; })
    .finally(() => inflight.delete(src));

  inflight.set(src, p);
  return p;
}

/** Build the through-my-domain URL for a format. */
function mediaProxyUrl(formatId, src) {
  const base = PUBLIC_BASE || '';
  return `${base}/api/media/${encodeURIComponent(formatId)}?src=${encodeURIComponent(src)}`;
}

function segProxyUrl(formatId, src, segUrl) {
  const base = PUBLIC_BASE || '';
  return `${base}/api/media/${encodeURIComponent(formatId)}?src=${encodeURIComponent(src)}&seg=${encodeURIComponent(segUrl.href)}`;
}

/* Pick headers worth forwarding to the CDN. Signed CDNs care mostly about
   Range / User-Agent / Referer; passing less of the client's fingerprint
   avoids leaking cookies/headers the CDN didn't sign for. */
function upstreamHeaders(format, clientReq) {
  const h = {
    ...(format.headers || {}),
    'user-agent': clientReq.header('user-agent') || format.headers?.['user-agent'] || 'Mozilla/5.0',
  };
  /* Some signed CDNs (googlevideo) only start responding when a Range header
     is present — fetch() without it stalls forever. Always send one. */
  h.range = clientReq.header('range') || 'bytes=0-';
  return h;
}

/** Stream an upstream CDN response to the client (206/200 passthrough). */
async function pipeUpstream(res, clientReq, targetUrl, format) {
  const controller = new AbortController();
  let upstream;
  try {
    upstream = await fetch(targetUrl, { headers: upstreamHeaders(format, clientReq), signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    /* aborted or network error — always answer the client so it can't hang */
    if (!res.headersSent) res.status(502).json({ error: 'upstream fetch failed', detail: String(err.message || err) });
    return;
  }
  if (upstream.status >= 400) {
    res.status(502).json({ error: `CDN returned ${upstream.status}` });
    return;
  }
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  /* Now wire the disconnect-abort: socket closed mid-stream → stop pulling.
     (Wiring this before fetch() is a trap: res 'close' can fire early and
     abort the fetch before it even starts.) */
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  if (!upstream.body) { res.end(); return; }
  try {
    await streamPipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    /* client disconnected / aborted — not an error; make sure the response closes */
    if (!res.writableEnded) res.end();
  }
}

/** Rewrite an HLS playlist so every sub-resource also goes through this domain. */
function rewriteHls(text, baseUrl, formatId, src) {
  const wrap = (absUrl) => segProxyUrl(formatId, src, absUrl);
  return text.split(/\r?\n/).map((line) => {
    if (!line.startsWith('#')) {
      const t = line.trim();
      if (!t) return line;
      let abs; try { abs = new URL(t, baseUrl); } catch { return line; }
      return wrap(abs);
    }
    return line.replace(/URI="([^"]+)"/g, (_m, u) => {
      let abs; try { abs = new URL(u, baseUrl); } catch { return _m; }
      return `URI="${wrap(abs)}"`;
    });
  }).join('\n');
}

/* List a platform URL's formats as proxied URLs (absolute when PUBLIC_BASE set). */
app.get('/api/media', async (req, res) => {
  const src = req.query.url || req.query.src;
  if (!src || !validUrl(src)) return res.status(400).json({ error: '?url= must be a valid http(s) URL' });
  try {
    const entry = await extractLinks(src);
    res.json({
      title: entry.title,
      source: src,
      formats: entry.formats.map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        protocol: f.protocol,
        url: mediaProxyUrl(f.format_id, src), // ← stream through this server
      })),
    });
  } catch (err) {
    res.status(502).json({ error: 'extraction failed', detail: err.message });
  }
});

/* The tunnel itself.
   /api/media/:formatId?src=<platform url>            → proxy bytes (Range works)
   ...&mode=redirect                                  → 302 to the CDN (no buffering)
   ...&seg=<absolute segment url>                     → internal: HLS segment hop */
app.get('/api/media/:formatId', async (req, res) => {
  const src = req.query.src;
  if (!src || !validUrl(src)) return res.status(400).json({ error: '?src= must be a valid http(s) platform URL' });
  const seg = req.query.seg;
  if (seg && !validUrl(seg)) return res.status(400).json({ error: 'invalid seg url' });

  try {
    const entry = await extractLinks(src);

    if (seg) {
      // sub-resource (HLS segment / key / chunklist): must belong to the cached
      // extraction (host check) so this can't be used as an arbitrary proxy.
      const { host } = new URL(seg);
      if (!entry.hosts.has(host)) return res.status(403).json({ error: `segment host ${host} not permitted` });
      return pipeUpstream(res, req, seg, { headers: {} });
    }

    const format = entry.formats.find((f) => String(f.format_id) === String(req.params.formatId));
    if (!format || !format.url) return res.status(404).json({ error: 'format not found' });

    if (req.query.mode === 'redirect') {
      return res.redirect(302, format.url);
    }

    // DASH manifest: XML rewriting is out of scope — hand the client the CDN URL.
    if (format.protocol.includes('dash')) {
      return res.redirect(302, format.url);
    }

    // HLS manifest: proxy + rewrite so segments keep streaming via this domain.
    if (format.protocol.includes('m3u8')) {
      let man;
      try {
        man = await fetch(format.url, { headers: upstreamHeaders(format, req) });
      } catch (err) {
        return res.status(502).json({ error: 'manifest fetch failed', detail: String(err.message || err) });
      }
      if (!man.ok) return res.status(502).json({ error: `manifest fetch ${man.status}` });
      const text = await man.text();
      const rewritten = rewriteHls(text, format.url, format.format_id, src);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }

    // plain progressive / http(s) media: pipe with Range passthrough
    return pipeUpstream(res, req, format.url, format);
  } catch (err) {
    res.status(502).json({ error: 'tunnel failed', detail: err.message });
  }
});

/* ---------------------------------- listen --------------------------------- */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Media Download API → http://0.0.0.0:${PORT}`);
  console.log(`  yt-dlp: ${YTDLP} | ffmpeg: ${FFMPEG_PATH || 'MISSING (mux/audio will fail)'} | cookies: ${COOKIES_FILE || 'none'} | max concurrent: ${MAX_CONCURRENT}`);
});
