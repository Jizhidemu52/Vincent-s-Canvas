# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

ARG VCS_REF=dev
ARG APP_VERSION=dev
ENV VITE_STANDALONE_EDITION=false

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
COPY shared /app/shared
RUN cd /app/shared && bun install --frozen-lockfile --production
RUN bun --no-env-file run build \
    && VCS_REF="$VCS_REF" APP_VERSION="$APP_VERSION" bun --no-env-file -e 'const version=(await Bun.file("/app/VERSION").text()).trim();if(process.env.APP_VERSION!=="dev"&&process.env.APP_VERSION!==version)throw Error("Release version mismatch");if(process.env.VCS_REF!=="dev"&&!/^[a-f0-9]{40}$/.test(process.env.VCS_REF||""))throw Error("Full release revision required");const edition=await Bun.file("dist/deployment-edition.json").json();if(edition.standalone!==false)throw Error("Enterprise build required");await Bun.write("dist/deployment-release.json",JSON.stringify({schema:1,version,commit:process.env.VCS_REF})+"\n")'

# 运行镜像：Nginx 提供前端，并把 /api 请求转发到公司后端。
FROM nginx:1.27-alpine

ARG VCS_REF=dev
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/Jizhidemu52/Vincent-s-Canvas" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
