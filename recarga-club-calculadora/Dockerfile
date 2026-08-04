FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV PORT=8787
ENV VIDEO_LIBRARY_DIR=/data/videos
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "video-compressor-server.js"]
