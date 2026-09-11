# Build the staged release first: pnpm package:build
FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS dependencies
WORKDIR /opt/agentlive
COPY dist/package/package.json dist/package/npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e
ENV NODE_ENV=production
WORKDIR /opt/agentlive
COPY --from=dependencies /opt/agentlive/ ./
COPY dist/package/cli.mjs ./cli.mjs
COPY dist/package/web/ ./web/
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7331
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:7331/readyz', {signal: AbortSignal.timeout(4000)}); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"]
ENTRYPOINT ["node", "/opt/agentlive/cli.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7331", "--state-dir", "/data"]
