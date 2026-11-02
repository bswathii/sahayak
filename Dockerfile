# Sahayak — single-container deployment.
# Node 24 on glibc slim so better-sqlite3 loads its prebuilt binary.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/sahayak.db \
    LOG_FORMAT=json

WORKDIR /app

# Dependencies first, for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY content ./content
COPY public ./public

# The SQLite file lives on a volume so a restart keeps sessions and events.
VOLUME ["/app/data"]
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.js"]
