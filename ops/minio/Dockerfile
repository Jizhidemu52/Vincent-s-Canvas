# Community images/binaries were withdrawn. Build the same pinned releases from
# official source, retaining the original S3 data format and command contract.
FROM golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee AS build
RUN apk add --no-cache ca-certificates curl
COPY ops/minio/build-from-source.sh /usr/local/bin/build-from-source.sh

FROM build AS mc-build
RUN sh /usr/local/bin/build-from-source.sh mc /out

FROM build AS minio-build
RUN sh /usr/local/bin/build-from-source.sh minio /out

FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates tzdata
COPY --from=mc-build /out/mc /usr/bin/mc
COPY --from=mc-build /out/licenses/ /licenses/mc/
COPY --from=mc-build /out/source/ /usr/share/minio-source/mc/

FROM runtime AS mc
ENTRYPOINT ["mc"]

FROM runtime AS minio
COPY --from=minio-build /out/minio /usr/bin/minio
COPY --from=minio-build /out/licenses/ /licenses/minio/
COPY --from=minio-build /out/source/ /usr/share/minio-source/minio/
VOLUME ["/data"]
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
