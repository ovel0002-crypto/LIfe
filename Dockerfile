# Life: server + PWA in one image.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# Build the PWA (served by the server from apps/app/dist).
RUN cd apps/app && CI=1 npx expo export --platform web

FROM base AS run
ENV NODE_ENV=production LIFE_APP_DIR=/repo/apps/app/dist LIFE_DATA_DIR=/data PORT=8787
COPY --from=build /repo /repo
WORKDIR /repo/apps/server
EXPOSE 8787
CMD ["npx", "tsx", "src/main.ts"]
