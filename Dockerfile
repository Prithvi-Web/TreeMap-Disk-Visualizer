# TreeMap server image — multi-stage: compile with dev deps, run on a slim
# Node 20 base with production deps only.
#
# Inside the container the server binds 0.0.0.0 (a 127.0.0.1 bind would be
# unreachable through the published port); docker-compose.yml maps it to
# 127.0.0.1 on the HOST by default, so out of the box the app stays
# localhost-only — the same posture as running it directly. Widen the port
# mapping and set TREEMAP_TOKEN when you actually want remote access.
#
# A container has no OS Trash and no display: treat this profile as
# scan-and-analyze (mount data read-only); destructive actions belong to the
# desktop app or a host-run server.

# ---- build: dev deps + tsc ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps only ----
FROM node:20-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4280 \
    TREEMAP_DATA_DIR=/data \
    TREEMAP_NO_GDU=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4280
CMD ["node", "dist/index.js"]
