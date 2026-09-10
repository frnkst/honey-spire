FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && npm ci \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=192

RUN groupadd --system --gid 999 neonhive \
    && useradd --system --uid 999 --gid neonhive --home-dir /app neonhive \
    && mkdir -p /data/app /data/geolite /data/cowrie \
    && chown -R neonhive:neonhive /data/app /data/geolite /data/cowrie

COPY --from=builder --chown=neonhive:neonhive /app/public ./public
COPY --from=builder --chown=neonhive:neonhive /app/.next/standalone ./
COPY --from=builder --chown=neonhive:neonhive /app/.next/static ./.next/static
COPY --from=builder --chown=neonhive:neonhive /app/scripts ./scripts

USER neonhive
EXPOSE 3000
CMD ["node", "server.js"]
