FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV VIDEO_LIBRARY_DIR=/data/videos
EXPOSE 10000
VOLUME ["/data"]

CMD ["node", "video-compressor-server.js"]
