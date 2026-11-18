# API Endpoints

Base URL: `http://localhost:3000` (or your deployed origin)

When `API_KEY` is set, API requests accept `x-api-key: <key>` or `Authorization: Bearer <key>`. The web UI reads the Access key field for each request.

---

## `GET /`

The media decoder web UI.

---

## `GET /api/health`

Queue and worker stats.

```bash
curl http://localhost:3000/api/health
```

```json
{ "ok": true, "queueDepth": 0, "running": 0, "active": 0 }
```

---

## `GET /api/info?url=<platform-url>`

Metadata + every available format. Each format entry includes the platform's
direct CDN/stream `url` — nothing is buffered.

```bash
curl "http://localhost:3000/api/info?url=https://youtu.be/dQw4w9WgXcQ"
```

```json
{
  "id": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "extractor": "Youtube",
  "duration_string": "3:33",
  "thumbnail": "https://i.ytimg.com/...",
  "uploader": "Rick Astley",
  "formats": [
    {
      "format_id": "137",
      "ext": "mp4",
      "resolution": "1920x1080",
      "fps": 25,
      "vcodec": "avc1.640028",
      "acodec": "none",
      "filesize": 80911999,
      "tbr": 3038.377,
      "protocol": "https",
      "note": "1080p",
      "url": "https://rr11---...googlevideo.com/videoplayback?..."
    }
  ]
}
```

**CDN-URL notes**
- Signed + short-lived (hours); often IP-locked to the caller of `/api/info`.
- `protocol: m3u8_native` / `dash` are manifests — need an HLS/DASH player.
- High-quality entries are video-only (`acodec: "none"`) — mux with an audio URL, or use `/api/download`.

**Errors**

| Code | Body |
|---|---|
| 400 | `{ "error": "query ?url= must be a valid http(s) URL" }` |
| 502 | `{ "error": "extraction failed", "detail": "..." }` |

---

## `POST /api/download`

Queue a server-side download job.

```bash
curl -X POST http://localhost:3000/api/download \
  -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","format":"mp4","quality":"1080"}'
```

Body fields:

| Field | Values | Default |
|---|---|---|
| `url` | any platform URL | required |
| `format` | `mp4` · `webm` · `mp3` · `m4a` · `audio` (opus) | `mp4` |
| `quality` | `best` · `2160` · `1440` · `1080` · `720` · `480` · `360` | `best` |

`202` response (job created, FIFO queue):

```json
{
  "id": "7b0aa691-22b9-4455-9a43-bc6982486979",
  "url": "https://youtu.be/dQw4w9WgXcQ",
  "options": { "format": "mp4", "quality": "1080" },
  "status": "queued",
  "progress": 0,
  "createdAt": 1794203665426
}
```

**Errors:** `400` invalid URL / unsupported preset.

---

## `GET /api/jobs`

All jobs, newest first.

```json
[
  {
    "id": "7b0aa691-...",
    "status": "downloading",
    "progress": 42.7,
    "speed": "2.51MiB/s",
    "eta": "00:12",
    "info": { "title": "...", "extractor": "Youtube" }
  }
]
```

---

## `GET /api/jobs/:id`

One job.

```json
{
  "id": "7b0aa691-...",
  "url": "...",
  "options": { "format": "mp4", "quality": "360" },
  "status": "done",
  "progress": 100,
  "filePath": "/app/downloads/7b0aa691-....mp4",
  "fileSize": 9174828,
  "createdAt": 1794203665426,
  "finishedAt": 1794203679020,
  "info": { "title": "...", "extractor": "Youtube" }
}
```

Statuses: `queued → downloading → merging → done | error | cancelled`.
`error` jobs carry an `error` message. Jobs live in memory (cleared on restart).

`404` when unknown id.

---

## `GET /api/jobs/:id/file`

The finished file, streamed with the video title as filename.

```bash
curl -o video.mp4 "http://localhost:3000/api/jobs/7b0aa691-.../file"
```

```
HTTP/1.1 200 OK
Content-Disposition: attachment; filename*=UTF-8''Rick%20Astley%20...%20.mp4
Content-Type: video/mp4
Content-Length: 9174828
```

| Code | Body |
|---|---|
| 404 | job not found |
| 409 | `{ "error": "file not ready (status: downloading, progress: 42.7%)" }` |

---

## `DELETE /api/jobs/:id`

Cancel a running job (SIGTERM → SIGKILL) or remove a finished job **and its file**.

```json
{ "ok": true, "cancelled": true }   // was running
{ "ok": true, "removed": true }     // was done/error/queued
```

---

## `GET /api/media?url=<platform-url>`

List formats as **proxied URLs** (streamed through this server's domain).
Absolute URLs when `PUBLIC_BASE` is set, relative otherwise.

```bash
curl "http://localhost:3000/api/media?url=https://youtu.be/dQw4w9WgXcQ"
```

```json
{
  "title": "Rick Astley - Never Gonna Give You Up",
  "source": "https://youtu.be/dQw4w9WgXcQ",
  "formats": [
    {
      "format_id": "139",
      "ext": "m4a",
      "resolution": "audio only",
      "protocol": "https",
      "url": "/api/media/139?src=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ"
    }
  ]
}
```

---

## `GET /api/media/:formatId?src=<platform-url>`

**Bytes proxy** — resolves the CDN link server-side (cached `LINK_TTL`, default
5 min) and streams it to you with true `Range`/`206` passthrough.

```bash
# play/stream directly
curl -o video.mp4 "http://localhost:3000/api/media/137?src=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ"

# seek support
curl -H "Range: bytes=1024-2047" -D - -o /dev/null ".../api/media/137?src=..."
# → HTTP/1.1 206 Partial Content
# → content-range: bytes 1024-2047/80911999
```

Query options:

| Param | Effect |
|---|---|
| `mode=redirect` | `302` to the CDN instead of proxying bytes (zero bandwidth on the server) |
| `seg=<absolute-url>` | internal: HLS segment/key hop (host-validated against the cached extraction) |

Behavior by format:
- **https (progressive)** — proxied with Range passthrough (206/200).
- **m3u8 (HLS)** — manifest proxied **and rewritten** so all segments also flow through this domain.
- **dash** — manifest not rewritten → automatic `302` redirect.

`302` (redirect mode), `404` format not found, `403` segment host not permitted, `502` upstream/CDN failure.

---

## `POST /api/update-extractors`

Runs `yt-dlp -U`. Use when a platform breaks — extractors are fixed upstream
within days.

```json
{ "ok": true, "output": ["yt-dlp is up to date (2026.10.26)"] }
```
