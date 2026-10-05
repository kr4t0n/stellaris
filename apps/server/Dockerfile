# syntax=docker/dockerfile:1

# The board server: the board, the scheduler, the HTTP API, the MCP endpoint, and the built
# interface, with the admin CLI beside it as `stellaris` for `init` and the other setup commands.
# It runs no turns, so it carries neither agent CLI. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t stellaris-server .

ARG NODE_VERSION=24

# What ships is JavaScript with no native modules, so it is built once on the builder's own
# platform and every target platform copies the output.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")"
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
RUN pnpm build && pnpm build:web
# Not offline: a deploy checks the lockfile against pnpm's supply-chain policy, which reads the
# registry's metadata.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @stellaris/server deploy --prod --store-dir /pnpm/store /out/server \
 && pnpm --filter @stellaris/cli deploy --prod --store-dir /pnpm/store /out/cli \
 && rm -rf /out/server/src /out/server/tsconfig.json /out/cli/src /out/cli/tsconfig.json \
 && cp -r apps/web/dist /out/web

FROM node:${NODE_VERSION}-trixie-slim
# git keeps every agent's home as a repository and serves it to runners through `git http-backend`;
# tini forwards signals to the server and reaps the git processes it starts.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git tini \
 && rm -rf /var/lib/apt/lists/*
# The homes under the data directory are the board's alone, whichever user owns the volume.
RUN git config --system safe.directory '*'
COPY --from=build /out /app
RUN printf '#!/bin/sh\nexec node /app/cli/dist/index.js "$@"\n' > /usr/local/bin/stellaris \
 && chmod +x /usr/local/bin/stellaris \
 && mkdir /data \
 && chown node:node /data
ENV STELLARIS_DATA_DIR=/data \
    STELLARIS_HOST=0.0.0.0 \
    STELLARIS_PORT=4700 \
    STELLARIS_WEB_DIR=/app/web
USER node
WORKDIR /app
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.STELLARIS_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/server/dist/index.js"]
