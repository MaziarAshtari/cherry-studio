# Cherry Studio self-hosted sync server.
# Runtime has zero npm dependencies: Node 24 runs the TypeScript sources directly
# (type stripping) and uses the built-in node:sqlite module.
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
