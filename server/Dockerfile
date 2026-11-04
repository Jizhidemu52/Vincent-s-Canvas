FROM oven/bun:1.3.13-alpine
ARG VCS_REF=dev
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/Jizhidemu52/Vincent-s-Canvas" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION
WORKDIR /app
RUN apk add --no-cache ffmpeg nodejs ca-certificates \
    && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (process.versions.bun || !((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major >= 25)) { console.error("Native Node.js 22.21+, 24.5+, or >=25 is required for explicit proxy support; found " + process.version); process.exit(1); }'
COPY server/package.json server/bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY server/src ./src
COPY shared /shared
COPY VERSION /app/VERSION
RUN cd /shared && bun install --frozen-lockfile --production
EXPOSE 3100
# Existing installations must never migrate or bootstrap merely by restarting.
# First-install/CI initialization is an explicit one-shot operation.
CMD ["bun", "src/index.ts"]
