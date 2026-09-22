# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:0.3.0@sha256:bca24ac970b21298430ad281f306dbe0a17be3fd1d6c9ec5f2cc73da65740b88 AS build
WORKDIR /app
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN vp install --frozen-lockfile
COPY --chown=1000:1000 . .
RUN vp run build
RUN install -d -o 1000 -g 1000 /app/runtime-data && \
  touch /app/runtime-data/.parcel-hopscotch-volume && \
  chown 1000:1000 /app/runtime-data/.parcel-hopscotch-volume

FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:0.3.0@sha256:bca24ac970b21298430ad281f306dbe0a17be3fd1d6c9ec5f2cc73da65740b88 AS production-dependencies
WORKDIR /app
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN vp install --prod --frozen-lockfile

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/parcel.sqlite
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/runtime-data /data
COPY --chown=node:node LICENSE ./LICENSE
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "dist/server/server/main.js"]
