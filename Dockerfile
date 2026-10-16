FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    INGEST_INTERVAL_HOURS=3

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.mjs index.html ./
COPY --chown=node:node js ./js
COPY --chown=node:node lib ./lib
COPY --chown=node:node data/archive.json ./data/archive.json
RUN mkdir -p /app/data/exports && chown -R node:node /app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
