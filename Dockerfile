FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY project.part* /tmp/
RUN cat /tmp/project.part* | base64 -d | tar -xJ -C /app && rm -f /tmp/project.part* && npm install --omit=dev
ENV NODE_ENV=production
CMD ["node", "server.js"]
