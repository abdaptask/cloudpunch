# CloudPunch API image for AWS (ADR-0035, ADR-0045). Runs the API the
# same way the pilot VM does: Node 20, the backend's TypeScript through
# tsx, and the built web dashboard served from apps/web/dist.
#
#   docker build -f infra/aws/Dockerfile -t cloudpunch-api .
#
# One image for the API and the one-off jobs (`infra/aws/ops.sh`).

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @cloudpunch/backend... --filter @cloudpunch/web... \
 && pnpm --filter @cloudpunch/web build
# No prune: the API runs its TypeScript through tsx (a dev dependency), as on the VM.

FROM node:20-alpine
# psql for the jobs; curl, gzip and GNU date/grep for the IP database.
RUN apk add --no-cache postgresql16-client curl gzip bash tini coreutils grep \
 && addgroup -S cloudpunch && adduser -S -G cloudpunch -u 10001 cloudpunch \
 && mkdir -p /data /run/cloudpunch && chown cloudpunch:cloudpunch /data /run/cloudpunch
WORKDIR /app
COPY --from=build --chown=root:root /app /app
ARG REVISION=unknown
RUN echo "$REVISION" > /app/REVISION
USER cloudpunch
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 \
    DOWNLOADS_DIR=/data/downloads DBIP_ASN_MMDB=/data/geo/dbip-asn-lite.mmdb
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/app/infra/aws/entrypoint.sh"]
CMD ["api"]
