# Media Download API — Node + yt-dlp + ffmpeg
FROM node:22-slim

# python3/pip only as a fallback yt-dlp source if the standalone download
# (bin/yt-dlp_linux) can't reach GitHub; ffmpeg comes from the ffmpeg-static
# npm package (see package.json), so no apt ffmpeg needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && (pip3 install --break-system-packages --no-cache-dir yt-dlp || echo "pip fallback unavailable — relying on standalone download")

WORKDIR /app

COPY package*.json ./
# Reuse the standalone binary (or pip fallback) for both runners.
COPY scripts ./scripts
RUN YOUTUBE_DL_SKIP_DOWNLOAD=1 npm ci --omit=dev && node scripts/install-ytdlp.js

COPY . .

ENV PORT=3000 \
    MAX_CONCURRENT=3 \
    CLEANUP_MINUTES=60

EXPOSE 3000

CMD ["node", "server.js"]
