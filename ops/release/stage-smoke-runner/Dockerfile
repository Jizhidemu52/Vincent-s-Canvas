# Only the disposable test runner is built here, never API or Web.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
ARG VCS_REF
LABEL org.opencontainers.image.revision=$VCS_REF io.canvas.stage.kind="browser-runner"
WORKDIR /smoke
COPY ops/release/stage-smoke-runner/package.json ops/release/stage-smoke-runner/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/e2e/production-smoke.config.ts web/e2e/production-smoke.browser.ts ./web/e2e/
COPY server/tests/production-smoke/identity.ts server/tests/production-smoke/mock-provider.ts ./server/tests/production-smoke/
COPY ops/release/stage-smoke-runner/check.cjs ./check.cjs
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "/smoke/node_modules/@playwright/test/cli.js", "test", "--config", "/smoke/web/e2e/production-smoke.config.ts"]
