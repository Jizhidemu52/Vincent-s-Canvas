FROM oven/bun:1.3.13-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg nodejs ca-certificates \
    && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (process.versions.bun || !((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major >= 25)) { console.error("Native Node.js 22.21+, 24.5+, or >=25 is required for explicit proxy support; found " + process.version); process.exit(1); }'
COPY server/package.json server/bun.lock* ./
RUN bun install --frozen-lockfile
COPY server ./
EXPOSE 3100
CMD ["sh", "-c", "bun src/migrate.ts && bun src/bootstrap.ts && bun src/index.ts"]
