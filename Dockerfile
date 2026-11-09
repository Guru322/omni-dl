# Media Download API — yt-dlp + ffmpeg + Node
FROM node:22-slim

# yt-dlp needs python3; ffmpeg merges/muxes streams and converts audio
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (extractor engine)
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000 \
    MAX_CONCURRENT=3 \
    CLEANUP_MINUTES=60

EXPOSE 3000

CMD ["node", "server.js"]
