# عالم البكلاوه — no npm dependencies: node:sqlite is built into Node 22.
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
