# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:1.0.0-rc.0@sha256:2777dc87ed4d842688af87d20e8452561609d20d78927c6c9544aa011b9b4e8f AS build
WORKDIR /app
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=parcel-hopscotch-pnpm-v1,target=/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile -- \
    --store-dir=/pnpm/store --network-concurrency=4 --fetch-timeout=300000
COPY --chown=1000:1000 . .
RUN vp run build
RUN install -d -o 1000 -g 1000 /app/runtime-data && \
  touch /app/runtime-data/.parcel-hopscotch-volume && \
  chown 1000:1000 /app/runtime-data/.parcel-hopscotch-volume

FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:1.0.0-rc.0@sha256:2777dc87ed4d842688af87d20e8452561609d20d78927c6c9544aa011b9b4e8f AS production-dependencies
WORKDIR /app
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=parcel-hopscotch-pnpm-v1,target=/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --prod --frozen-lockfile -- \
    --store-dir=/pnpm/store --network-concurrency=4 --fetch-timeout=300000

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
