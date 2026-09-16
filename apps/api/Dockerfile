# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/api/Dockerfile -t hfos-api .
# Runtime env (apps/api/src/env.ts): SUPABASE_URL, DATABASE_URL (the hfos_api role), WEB_ORIGINS,
# optional LOG_LEVEL and TRUST_PROXY. Never pass a secret key: the process refuses to boot with one.

FROM node:22-alpine AS base
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .pnpmfile.mjs ./
# Hoisted, copied (not hard-linked) layout: the bundled workspace code resolves third-party packages
# from the app's own node_modules, and `pnpm deploy` works across Docker layers.
RUN printf '\nnodeLinker: hoisted\npackageImportMethod: copy\n' >> pnpm-workspace.yaml
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @hfos/api...
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @hfos/api build
# A self-contained copy of the app with only its production dependencies.
RUN pnpm --filter @hfos/api deploy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "dist/server.js"]
