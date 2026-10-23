FROM golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee AS build
RUN apk add --no-cache ca-certificates curl
COPY ops/minio/build-from-source.sh /usr/local/bin/build-from-source.sh

FROM build AS mc-build
RUN sh /usr/local/bin/build-from-source.sh mc /out

FROM alpine:3.21
RUN apk add --no-cache bash python3 age postgresql17-client curl ca-certificates tzdata
COPY --from=mc-build /out/mc /usr/local/bin/mc
COPY --from=mc-build /out/licenses/ /licenses/mc/
COPY --from=mc-build /out/source/ /usr/share/minio-source/mc/
COPY ops/backup/backup.sh /usr/local/bin/backup.sh
COPY ops/backup/restore.sh /usr/local/bin/restore.sh
COPY ops/backup/archive.py /usr/local/bin/archive.py
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["/usr/local/bin/backup.sh"]
