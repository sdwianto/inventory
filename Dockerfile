# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# preinstall needs ee12 script + vendored @sdwianto packages (see compose additional_contexts)
COPY scripts/ee12-install-platform.mjs ./scripts/
COPY --from=sales_pkgs contracts ./_vendor/sales/packages/contracts
COPY --from=sales_pkgs events ./_vendor/sales/packages/events
COPY --from=sales_pkgs metrics ./_vendor/sales/packages/metrics
COPY --from=sales_pkgs platform ./_vendor/sales/packages/platform
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# restore vendor after COPY . . (build context has no _vendor tree)
COPY --from=deps /app/_vendor ./_vendor
# file: deps are often symlinks — materialize real copies for Next/webpack
RUN mkdir -p node_modules/@sdwianto \
  && rm -rf node_modules/@sdwianto/contracts node_modules/@sdwianto/events node_modules/@sdwianto/metrics node_modules/@sdwianto/platform \
  && cp -a _vendor/sales/packages/contracts node_modules/@sdwianto/contracts \
  && cp -a _vendor/sales/packages/events node_modules/@sdwianto/events \
  && cp -a _vendor/sales/packages/metrics node_modules/@sdwianto/metrics \
  && cp -a _vendor/sales/packages/platform node_modules/@sdwianto/platform \
  && test -f node_modules/@sdwianto/platform/src/queue/enqueue.ts \
  && test -f node_modules/@sdwianto/metrics/src/prometheus.ts \
  && test -f node_modules/@sdwianto/platform/src/metrics/observability-collector.ts
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# su-exec: entrypoint (root) siapkan /app/storage lalu drop ke nextjs
RUN apk add --no-cache su-exec \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/storage/media \
  && chown -R nextjs:nodejs /app/storage

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-bg-worker.mjs ./scripts/run-bg-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-entry.sh ./scripts/docker-entry.sh
RUN chmod +x /app/scripts/docker-entry.sh

# Root hanya untuk entrypoint (mkdir/chown volume); proses app = nextjs
USER root
EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV MEDIA_STORAGE_PATH=/app/storage/media

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "scripts/docker-entry.sh"]
CMD ["node", "server.js"]
