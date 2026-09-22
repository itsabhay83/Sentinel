# Sentinel — container image for every process in the stack.
#
# Targets:
#   --target scheduler  scheduler, plus the migrate/seed CLIs
#   --target probe      regional probe worker (needs ICMP)
#   --target web        Next.js production server
#
# All three run compiled JavaScript as the unprivileged `node` user and carry a
# HEALTHCHECK. No devDependencies, no tsx, no TypeScript reach the final stages.

FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /app


# deps — manifests only, then a full install (devDependencies included; tsup,
# typescript and tailwind are all build-time requirements).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json         apps/web/package.json
COPY apps/scheduler/package.json   apps/scheduler/package.json
COPY apps/probe/package.json       apps/probe/package.json
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/db/package.json      packages/db/package.json
COPY packages/checker/package.json packages/checker/package.json
RUN pnpm install --frozen-lockfile


# prod-deps — the runtime dependency closure for the two Node services. The
# workspace packages are bundled into the tsup output, so only their published
# dependencies (bullmq, ioredis, pino, drizzle-orm, resend) need to be present.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json         apps/web/package.json
COPY apps/scheduler/package.json   apps/scheduler/package.json
COPY apps/probe/package.json       apps/probe/package.json
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/db/package.json      packages/db/package.json
COPY packages/checker/package.json packages/checker/package.json
RUN pnpm install --frozen-lockfile --prod \
      --filter @sentinel/scheduler --filter @sentinel/probe


# source — dependency tree plus the workspace itself.
FROM deps AS source
COPY tsconfig.base.json tsconfig.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts


# node-build — tsup compiles scheduler, probe and the db CLIs to ESM.
FROM source AS node-build
RUN pnpm --filter @sentinel/scheduler --filter @sentinel/probe run build


# web-build — `next build`.
#
# Next evaluates module-level code while collecting page data, and
# packages/shared/src/env.ts validates the whole environment with Zod at import
# time, so the build needs a schema-valid environment. These values exist only
# in this stage; the final `web` stage starts from `base` and therefore cannot
# inherit any of them as a runtime default.
#
# NEXT_PUBLIC_APP_URL is the exception: Next inlines it into the client bundle,
# so it is a build arg that must match the URL the browser will actually use.
FROM source AS web-build
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    BETTER_AUTH_URL=$NEXT_PUBLIC_APP_URL \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-runtime
RUN pnpm --filter @sentinel/web build


# scheduler — dispatcher, consensus, alerting. Also carries the migrate and
# seed CLIs so one-shot jobs reuse this image.
#
# migrate.js resolves its SQL folder relative to its own file
# (`dirname(import.meta.url)/../migrations`), which is why the drizzle
# migrations are copied to /app/apps/scheduler/migrations and nowhere else.
FROM base AS scheduler
RUN apk add --no-cache ca-certificates
ENV NODE_ENV=production \
    SCHEDULER_HEALTH_PORT=4000
WORKDIR /app/apps/scheduler
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/scheduler/node_modules ./node_modules
COPY --from=node-build --chown=node:node /app/apps/scheduler/dist ./dist
COPY --from=node-build --chown=node:node /app/packages/db/migrations ./migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=4 \
  CMD node -e "const p=process.env.SCHEDULER_HEALTH_PORT||'4000';fetch('http://127.0.0.1:'+p+'/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]


# probe — regional worker.
#
# iputils supplies a real `ping`/`ping6`; the ICMP checker shells out to them
# with an argv array (packages/checker/src/ping.ts) and busybox's applet does
# not accept the same `-W`/`-w` pair. The binary is given CAP_NET_RAW as a file
# capability so the unprivileged `node` user can open a raw socket — the
# container itself must still hold CAP_NET_RAW (Docker's default; under
# Kubernetes it has to be added back explicitly, see deploy/k8s).
FROM base AS probe
RUN apk add --no-cache iputils ca-certificates libcap \
 && setcap cap_net_raw+ep "$(readlink -f "$(command -v ping)")" \
 && apk del libcap
ENV NODE_ENV=production \
    PROBE_HEALTH_PORT=4100
WORKDIR /app/apps/probe
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/probe/node_modules ./node_modules
COPY --from=node-build --chown=node:node /app/apps/probe/dist ./dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=4 \
  CMD node -e "const p=process.env.PROBE_HEALTH_PORT||'4100';fetch('http://127.0.0.1:'+p+'/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]


# web — the standalone Next server. `output: "standalone"` (apps/web/
# next.config.ts) emits a self-contained node_modules, so nothing from the
# build stage's dependency tree is carried over.
FROM base AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=6 \
  CMD node -e "const p=process.env.PORT||'3000';fetch('http://127.0.0.1:'+p+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
