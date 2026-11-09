# Media Download API — Node + yt-dlp + ffmpeg
FROM node:22-slim

# python3/pip only as a fallback yt-dlp source if the postinstall download
# (bin/yt-dlp_linux) can't reach GitHub; ffmpeg comes from the ffmpeg-static
# npm package (see package.json), so no apt ffmpeg needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && (pip3 install --break-system-packages --no-cache-dir yt-dlp || echo "pip fallback unavailable — relying on postinstall download")

WORKDIR /app

COPY package*.json ./
# postinstall (scripts/install-ytdlp.js) must exist when npm ci runs it
COPY scripts ./scripts
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000 \
    MAX_CONCURRENT=3 \
    CLEANUP_MINUTES=60

EXPOSE 3000

CMD ["node", "server.js"]
