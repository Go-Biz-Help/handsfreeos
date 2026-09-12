# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/worker/Dockerfile -t hfos-worker .
# Runtime env (apps/worker/src/env.ts): DATABASE_URL_WORKER (the hfos_worker role), SMTP_URL, MAIL_FROM,
# WEB_URL, SUPABASE_URL and SUPABASE_SECRET_KEY (Storage, imports, photos; the worker is the only app that
# holds provider secrets), WORKER_ENCRYPTION_KEY (seals subaccount tokens), WORKER_PUBLIC_URL (the https
# address providers call), WEB_ORIGINS, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, optional
# TWILIO_PRIMARY_PROFILE_SID (local-number registration), WORKER_ENCRYPTION_KEYS_PREVIOUS, WORKER_HTTP_PORT (4100), WORKER_POLL_MS, WORKER_BATCH_SIZE, LOG_LEVEL.

FROM node:22-alpine AS base
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Hoisted, copied (not hard-linked) layout: the bundled workspace code resolves third-party packages
# from the app's own node_modules, and `pnpm deploy` works across Docker layers.
RUN printf '\nnodeLinker: hoisted\npackageImportMethod: copy\n' >> pnpm-workspace.yaml
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @hfos/worker...
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN pnpm --filter @hfos/worker build
# A self-contained copy of the app with only its production dependencies.
RUN pnpm --filter @hfos/worker deploy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:4100/healthz || exit 1
CMD ["node", "dist/main.js"]
