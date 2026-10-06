# syntax=docker/dockerfile:1

# A runner on climage's `full` variant, which brings Claude Code, Codex, and the toolchains agents
# shell out to. Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t stellaris-runner .

ARG NODE_VERSION=24
ARG CLIMAGE_VERSION=0.3.0

# Built on the target platform, not the builder's: the Claude Agent SDK runs Claude Code from a
# binary in a per-platform optional package, and pnpm installs only the one for the platform it
# runs on. climage is Debian bookworm, so the build stage is too.
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")"
RUN --mount=type=cache,id=pnpm-store-runner,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store-runner,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
RUN pnpm exec tsc -b apps/runner
# Not offline: a deploy checks the lockfile against pnpm's supply-chain policy, which reads the
# registry's metadata.
RUN --mount=type=cache,id=pnpm-store-runner,target=/pnpm/store \
    pnpm --filter @stellaris/runner deploy --prod --store-dir /pnpm/store /out/runner \
 && rm -rf /out/runner/src /out/runner/tsconfig.json

FROM kr4t0n/climage:${CLIMAGE_VERSION}-full
USER root
# climage's account becomes `stellaris`, keeping uid 1000 and the shared `users` group (gid 100),
# and its home moves to /home/stellaris. Every variable climage points into the home is set again,
# with PATH in climage's order, and so is the login shells' copy of PATH.
RUN usermod --login stellaris --home /home/stellaris --move-home climage \
 && sed -i 's#/home/climage#/home/stellaris#g' /etc/profile.d/10-climage-path.sh
ENV PATH=/home/stellaris/.npm-global/bin:/home/stellaris/.uv/bin:/home/stellaris/.go/bin:/home/stellaris/.cargo/bin:/opt/uv/bin:/opt/rust/cargo/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GOPATH=/home/stellaris/.go \
    GOBIN=/home/stellaris/.go/bin \
    GOCACHE=/home/stellaris/.go/cache \
    GOENV=/home/stellaris/.go/env \
    CARGO_INSTALL_ROOT=/home/stellaris/.cargo \
    NPM_CONFIG_PREFIX=/home/stellaris/.npm-global \
    UV_TOOL_DIR=/home/stellaris/.uv/tools \
    UV_TOOL_BIN_DIR=/home/stellaris/.uv/bin \
    UV_CACHE_DIR=/home/stellaris/.cache/uv
# A climage version that names its home in a place this file does not know fails the build here,
# rather than leaving a tool pointed at a home that no longer exists. usermod's backups of the old
# account files, which end in `-`, are the one place the old name may stay.
RUN if env | grep -q /home/climage || grep -rqs --exclude='*-' /home/climage /etc /home/stellaris; then \
      echo "a path still names /home/climage" >&2; exit 1; \
    fi
COPY --from=build /out/runner /opt/stellaris-runner
RUN printf '#!/bin/sh\nexec node /opt/stellaris-runner/dist/index.js "$@"\n' > /usr/local/bin/stellaris-runner \
 && chmod +x /usr/local/bin/stellaris-runner
USER stellaris
# Everything the runner keeps sits in the home, beside the CLIs' logins in ~/.claude and ~/.codex
# and whatever agents install, so one volume at /home/stellaris carries all of it across restarts:
# its saved credentials, the agents' homes, and the repositories and worktrees of its projects.
ENV STELLARIS_RUNNER_DIR=/home/stellaris/stellaris-runner
# climage's entrypoint stays, behind tini, which reaps the CLI and git processes turns start and
# hands SIGTERM to the runner so it drains its turns.
CMD ["stellaris-runner"]
