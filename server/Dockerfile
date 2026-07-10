FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY server/package.json server/bun.lock* ./
RUN bun install --frozen-lockfile
COPY server ./
EXPOSE 3100
CMD ["sh", "-c", "bun src/migrate.ts && bun src/bootstrap.ts && bun src/index.ts"]
