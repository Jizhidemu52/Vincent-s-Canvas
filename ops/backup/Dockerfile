FROM alpine:3.21
RUN apk add --no-cache bash postgresql17-client curl ca-certificates tzdata \
    && curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc
COPY ops/backup/backup.sh /usr/local/bin/backup.sh
COPY ops/backup/restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["/usr/local/bin/backup.sh"]
