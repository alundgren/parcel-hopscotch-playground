# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32 AS build
ARG TARGETARCH
WORKDIR /app
RUN npm install --global pnpm@12.5.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm deploy --prod --cpu=$TARGETARCH --os=linux /runtime
RUN install -d -o 1000 -g 1000 /runtime-data && \
  touch /runtime-data/.parcel-hopscotch-volume && \
  chown 1000:1000 /runtime-data/.parcel-hopscotch-volume

FROM node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/parcel.sqlite
COPY --from=build --chown=node:node /runtime/package.json ./package.json
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /runtime-data /data
COPY --chown=node:node LICENSE ./LICENSE
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "dist/server/server/main.js"]
