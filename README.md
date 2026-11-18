# Media Download API — omni-dl

Express.js REST API for downloading media from **~1,800 sites** (YouTube, Instagram, TikTok, X/Twitter, Reddit, SoundCloud, ...) — the same engine that powers [Seal](https://github.com/junkfood02/Seal): **yt-dlp** (extractors) + **ffmpeg** (merging/converting).

YouTube metadata, media links, and download jobs use `youtube-dl-exec`. It wraps the same `yt-dlp` executable used by the CLI runner for other sites, so the extractor update endpoint applies to both.

## Setup

```bash
# Requires Node.js 22 and Python 3.11+ on macOS/Linux
npm install
cp .env.example .env           # optional — edit config (auth, cookies, domain, tuning)
npm start                      # → http://localhost:3000
```

If the install environment cannot download the extractor from GitHub, set `YOUTUBE_DL_SKIP_DOWNLOAD=1` during installation and supply a working `yt-dlp` on `PATH` or via `YTDLP_PATH` at runtime.

Config knobs are documented in `.env.example`: `PORT`, `API_KEY`, `COOKIES_FILE`, `MAX_CONCURRENT`, `CLEANUP_MINUTES`, `PUBLIC_BASE`, `LINK_TTL`. Environment variables always work too — `npm start` loads `.env` via `--env-file-if-exists` (skipped if absent).

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | media decoder web UI |
| GET | `/api/health` | queue + worker stats |
| GET | `/api/info?url=...` | metadata + formats, **each with a direct CDN/stream `url`** |
| POST | `/api/download` | queue a server-side download job |
| GET | `/api/jobs` | list all jobs |
| GET | `/api/jobs/:id` | job status + progress |
| GET | `/api/jobs/:id/file` | download the finished file |
| DELETE | `/api/jobs/:id` | cancel running / remove finished job |
| POST | `/api/update-extractors` | run `yt-dlp -U` |

### POST /api/download body

```json
{ "url": "https://...", "format": "mp4|webm|mp3|m4a|audio", "quality": "best|2160|1440|1080|720|480|360" }
```

### Example flow

```bash
# 1. inspect
curl "http://localhost:3000/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 2. queue
JOB=$(curl -s -X POST http://localhost:3000/api/download \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","format":"mp4","quality":"1080"}')

# 3. poll
curl "http://localhost:3000/api/jobs/$(...id...)"

# 4. get the file
curl -o video.mp4 "http://localhost:3000/api/jobs/<id>/file"
```

## Authenticated / age-restricted content

Export cookies from your browser (extension: "Get cookies.txt") and run with:

```bash
COOKIES_FILE=/path/to/cookies.txt API_KEY=secret npm start
```

When `API_KEY` is set, enter it in the decoder’s **Access key** field. API clients can send either `x-api-key: <key>` or `Authorization: Bearer <key>`.

## Tunneling through your own domain (`/api/media`)

Serve media pieces from **your** domain instead of exposing raw CDN hosts — the flow behind `api.gurusensei.dev/api/media/...`:

```bash
PUBLIC_BASE=https://api.gurusensei.dev npm start
```

| Endpoint | What it does |
|---|---|
| `GET /api/media?url=<platform-url>` | lists formats, each with a ready-to-use proxied URL |
| `GET /api/media/:formatId?src=<platform-url>` | **bytes proxy** — Range-passthrough streaming through your server |
| `...&mode=redirect` | 302 to the CDN instead (zero bandwidth on your box) |
| HLS manifest endpoints | manifest is proxied **and rewritten** so segments keep flowing through your domain |

```bash
# 1. list proxy URLs
curl "https://api.gurusensei.dev/api/media?url=https://youtu.be/dQw4w9WgXcQ"
# → { "url": "https://api.gurusensei.dev/api/media/137?src=https%3A%2F%2F..." }

# 2. play it — works in <video>, VLC, ffmpeg -i ...
#    seeking works too (real 206 Range passthrough to the CDN)
```

Implementation notes: resolved links are cached (`LINK_TTL`, default 5 min) so each stream request runs at most one extraction per source; HLS segment URLs are host-validated against the cached extraction (no arbitrary open proxying); DASH manifests aren't rewritten and fall back to redirect mode.

Behind Nginx, disable buffering so streaming works: `location /api/media/ { proxy_buffering off; }` (Caddy does this by default).

## Direct URLs (no server buffering)

`/api/info` never buffers media — every entry in `formats` includes `url`, the platform's direct CDN/stream link:

```json
{ "format_id": "137", "ext": "mp4", "resolution": "1920x1080",
  "vcodec": "avc1.640028", "acodec": "none",
  "protocol": "https",
  "url": "https://rr11---...googlevideo.com/videoplayback?..." }
```

Feed that URL straight into <video>/<audio>, VLC, ffmpeg, your own client, etc. Caveats you should know by design:

- Links are **signed + short-lived** (typically hours) and some platforms IP-lock them — call `/api/info` fresh when you need a link, and play it from the same IP that called `/api/info`.
- `protocol: m3u8_native / dash` entries are **manifests** — you need an HLS/DASH player (or ffmpeg) to play/merge them.
- High-quality entries are usually **video-only** (`acodec: none`) or audio-only — mux two URLs client-side (or use `POST /api/download` where ffmpeg does it for you).

## Docker

```bash
docker build -t media-api .
docker run -p 3000:3000 -v media-downloads:/app/downloads --env-file .env media-api
# with cookies + auth:
docker build -t media-api . && docker run -p 3000:3000 -e API_KEY=secret \
  -v /path/cookies.txt:/app/cookies.txt -e COOKIES_FILE=/app/cookies.txt media-api
```

## Notes

- Downloads run as yt-dlp subprocesses, max `MAX_CONCURRENT` at a time (default 3), FIFO queue.
- Finished files are auto-deleted after `CLEANUP_MINUTES` (default 60).
- If a site breaks, `POST /api/update-extractors` usually fixes it — yt-dlp extracts are updated within days of any platform change.
- Use responsibly; respect each platform's ToS and copyright law.
