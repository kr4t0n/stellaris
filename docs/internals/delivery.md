# Building, releasing, and publishing

The toolchain and its rules, what CI checks, how the images, the npm packages, and the chart are built and published, and how commits reach `dev` and releases reach `main`. [AGENTS.md](../../AGENTS.md) states the rules in short; this page has the detail. Deploying a society is in the [README](../../README.md#deployment) and the [chart's README](../../helm/stellaris/README.md).

## The toolchain

### TypeScript 7, ESM only

Relative imports use the `.js` suffix even though sources are `.ts`; tsc, tsx, and Vitest all resolve it. Packages use the Node resolution mode.

### Build with project references

`pnpm build` runs `tsc -b` from the root solution file, and so does `pnpm typecheck`: TypeScript refuses `tsc -b --noEmit` for a project another one references (TS6310), so the build is the type check. Adding a package means adding it to `tsconfig.json` at the root and to the `references` of every package that imports it, and every import must be a declared dependency because pnpm's layout is strict.

### Strict options are on

Strict options are on, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Optional fields on input interfaces are typed `?: T | undefined`. When building objects for Zod schemas or SDK options, spread optional fields conditionally rather than assigning `undefined`; the SDKs' option types reject explicit `undefined`.

### Exact dependency versions

No caret ranges. CI installs with a frozen lockfile.

### Lint and format with oxlint and oxfmt

This is a deliberate exception to the ESLint standard elsewhere; do not add ESLint or Prettier. Type-aware linting needs the build's declaration files, so build before lint. Keep lint warning-free; use type guards or Zod instead of assertions.

### TypeScript 6 and 7 no longer auto-include `@types/*`

The base config sets `"types": ["node"]`. A new package that forgets to extend the base config will fail with "cannot find name 'node:fs'".

### pnpm 12 blocks postinstall scripts by default

Allowed builds are listed in `pnpm-workspace.yaml`. Only esbuild is allowed today.

### pnpm 12 enforces a minimum release age

Pinning a version published within that window requires an entry in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.

### `oxfmt` reformats `package.json` and markdown

Running `pnpm format` touches more than TypeScript; after it runs, exact-match edits against long lines will miss.

## CI

`ci.yml` runs on every pull request and on every push to `main` and `dev`. Its `check` job, the one the branch rules require, scans the whole history for secrets with a pinned gitleaks whose archive it checks against its sha256, then installs with a frozen lockfile and runs `pnpm build`, `pnpm build:web`, `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm test:e2e`, the same chain `pnpm check` runs locally without the scan. The `images`, `npm`, and `chart` jobs run beside it, build what a release ships, and push nothing; they are not required. `ios.yml` runs the iOS client's tests on macOS, on pull requests and pushes that change `apps/ios`, and is not required either ([ios.md](ios.md#iosyml-runs-on-macos-and-no-rule-requires-it)). `publish.yml`, `npm-publish.yml`, and `helm-publish.yml` run on pushes to `main`, the first two also on `v*` tags, and all three by hand, never on a pull request, so none of their checks can be required of one.

## The commit hook

### A commit hook scans for secrets

`pnpm install` installs husky through `prepare`, and `.husky/pre-commit` runs `gitleaks git --pre-commit --staged --redact --no-banner` and refuses the commit on a finding or when gitleaks is missing; `ci.yml` scans the whole history with a pinned gitleaks whose checksum it checks. On a runner, `HUSKY=0` keeps the hook out of the clone every worktree shares, so run that command yourself before each commit. A verified false positive goes in `.gitleaks.toml`. Without a `.git`, as in an image's build context, husky skips its install and the install goes on.

## Container images

### Images are built from the repository root and published by CI

`apps/server/Dockerfile` builds on the builder's own platform, since nothing shipped is native, and `pnpm deploy --prod` gives the server and the CLI each a self-contained tree with their workspace packages copied in, which the runtime stage copies beside the built interface; it adds git, which the board needs for agents' homes and `git http-backend`, and tini, which reaps those git processes. `publish.yml`, a workflow of its own beside `ci.yml`, builds every image in its matrix on a native runner per platform (`ubuntu-24.04` and `ubuntu-24.04-arm`, never QEMU), pushes each build to Docker Hub by digest, and a merge job joins the digests under the image's tags with `docker buildx imagetools create`; an image added to the build matrix needs its name in the merge matrix too. A push to `main` tags each image `latest`, `main`, and `sha-<commit>`, a `v*` tag the version and its major and minor (`0.3.25`, `0.3`), and a manual run `manual-<run id>`; the workflow runs beside `ci` and does not wait for its checks.

`apps/runner/Dockerfile` cannot do that: the Claude Agent SDK runs Claude Code from a binary in a per-platform optional package (`@anthropic-ai/claude-agent-sdk-linux-x64`, `-linux-arm64`, and so on), and pnpm installs only the one for the platform it runs on, so its build stage runs on the target platform, natively in CI and under emulation for a cross-platform build on one machine, and compiles only the runner and the packages it references (`tsc -b apps/runner`). Its runtime stage is climage's `full` variant at a pinned `CLIMAGE_VERSION`, which brings Claude Code, Codex, and the agents' toolchains, under climage's tini and entrypoint. It renames climage's account to `stellaris` (uid 1000, gid 100) and moves its home to `/home/stellaris`, which means setting again every variable climage points into the home (`PATH` in climage's order, the Go, Cargo, npm, pnpm, and uv locations) and rewriting `/etc/profile.d/10-climage-path.sh`, the login shells' copy of `PATH`; a build step fails if any variable or file under `/etc` or the home still names `/home/climage`, so a climage release that adds one is caught at the version bump. climage's `HELM_PLUGINS`, where helm-diff is, names a root-owned directory outside the home, so the move leaves it as it is. The runner's data directory is `/home/stellaris/stellaris-runner`, so one home volume holds it with the CLIs' logins. The SDK's binary, not climage's `claude`, runs the turns, so the Claude Code a turn runs is the one the SDK pins; both read the same login.

`ci.yml`'s `images` job builds both on every pull request and every push to `main` and `dev`, for `linux/amd64` alone and with no layer cache, pushes nothing, and runs them with `scripts/docker/smoke.sh`, which mounts nothing from the checkout: the server image creates a society on a fresh volume, starts with its own command, passes its own health check, and serves the interface, and the runner image's own command, as `stellaris` (1000:100) with `claude`, `codex`, `git`, `kubectl`, `helm` with its `diff` plugin, and `helmfile` on its `PATH`, enrolls with that server and connects, both reporting `STELLARIS_VERSION`. An arm64-only failure, such as a missing per-platform package, still shows first in `publish.yml` on `main`.

## The npm packages

### The npm packages bundle the workspace

`scripts/npm/pack.mjs` builds `@kubitnodes/stellaris` (the CLI and the server, bins `stellaris` and `stellaris-server`, with the built interface) and `@kubitnodes/stellaris-runner` into `release/`, with esbuild from each app's `dist/index.js`: the workspace's own packages are bundled in, since none of them is published, and every other import stays external and becomes a dependency at the version a workspace `package.json` pins, read from the bundle's metafile, so the published dependencies are exactly what the code imports. A third-party import no workspace package declares fails the pack. The server's bundle sits at `dist/server/index.js` and the interface at `web/dist`, because the server looks for it at `../../web/dist` from its own file, as in the repository. `STELLARIS_VERSION` in `shared` is the one version: the CLI, the server, and the runner report it (`--version`), the packages publish it, and `npm-publish.yml`, shaped like nodex's and using trusted publishing, refuses a tag that does not match it and leaves a version already on npm alone. `scripts/npm/smoke.sh` installs the packed tarballs and runs a society, the server, and a runner against each other; `npm-publish.yml`, a workflow of its own beside `ci.yml`, packs and runs it on every push to `main` and publishes only on a tag or by hand, and `ci.yml`'s `npm` job packs and runs it on every pull request and every push to `main` and `dev`. Each package's trusted publisher on npm must allow `npm publish`, not only `npm stage publish`.

To run the same check as CI's `npm` job locally, after `pnpm build` and `pnpm build:web`: `pnpm pack:npm`, then `npm pack ./release/stellaris ./release/stellaris-runner --pack-destination <dir>`, then `scripts/npm/smoke.sh <dir>`, which wants a folder of `.tgz` files rather than `release/`. It installs the tarballs into a scratch prefix and runs a society, the server, and a runner against each other.

## The Helm chart

### The Helm chart deploys the server, and runners when asked

`helm/stellaris` is shaped like argus's chart (`_helpers.tpl`, per-component `server` and `runner` values, one Ingress) and published the same way, by `helm-publish.yml` into `gh-pages/helm` once per chart `version`, starting the branch on its first run. Its Deployment is one replica with `Recreate`, because the server is the data directory's only writer, and an init container creates the society on an empty volume with the seed-role citizens of `society.citizens`, writing the user token to `/data/initial-user-token` (mode 600), or to `/dev/null` when `auth.github` is on, and every citizen's token to `/dev/null`, never to a log; GitHub sign-in's client secret comes from a Secret, the chart's own or `auth.github.existingSecret`, whose checksum on the pod restarts the server when the chart's changes. `stellaris.validate` refuses a citizen the first start could not create and anything the init script would have to quote; the society's name reaches the script as an environment variable. `appVersion` names the image tag pulled by default for both images, which exists only once a `v<appVersion>` tag has been pushed.

`runner.enabled` (off by default) adds a StatefulSet of the runner image rather than a Deployment, because each pod is a runner of its own: its name stays, so the board's suggested name, the pod's hostname, keeps meaning that pod, and `volumeClaimTemplates` give each a claim at `/home/stellaris` holding its CLI logins, its enrollment, and the repositories of the projects living on it, kept by Kubernetes on scale-down and uninstall. `runner.extraInitContainers`, `extraVolumes`, and `extraVolumeMounts` pass through to the pod for what a runner needs before it starts, such as an SSH key from a Secret; an init container reaches the home by the claim template's name, `home`, so no extra volume may take that name, which `stellaris.validate` refuses since Kubernetes would quietly put the claim in its place, and `fsGroup` makes both the home and a Secret volume's files the runner group's before any container starts, so such a copy needs no root. Each replica enrolls by itself unless `runner.existingSecret` gives one replica a token; `STELLARIS_SERVER_URL` defaults to the chart's Service as `<name>.<namespace>.svc`, so agents reach the MCP endpoint inside the cluster. The claim template carries only the selector labels, since Kubernetes refuses any change to it after install and the version labels change with every chart. Agents run with every permission, so the pods get `enableServiceLinks: false` always and a service-account token only when `runner.automountServiceAccountToken` asks for one, of the account `runner.serviceAccountName` names (the namespace's `default` when empty); the chart never creates or binds an account, since what agents may do in the cluster is the deployer's to grant. `runner.networkPolicy` (off by default, since it needs an enforcing network plugin) allows DNS by port, the server's pods, and the internet outside the private, shared, and link-local ranges, and no ingress; it is no guard for the API server, since Kubernetes leaves it to the network plugin whether an `ipBlock` sees a Service's address or the one it is rewritten to, so a runner keeps the API from its agents by having no token, and agents with one need `extraEgress` rules for both the `kubernetes` Service's address and the API server's own, which the private ranges often hold. The governing Service a StatefulSet names is never created: nothing connects to a runner.

`runner.pools` turns the one StatefulSet into one per pool, for runners that differ in placement, capabilities, or size, since every replica of a StatefulSet is the same pod. `stellaris.runner.sets` builds each pool's values from `runner`'s, with a field the pool sets replacing the block's, except `image`, `config`, and `persistence`, which take the pool's fields one at a time, and every template and `stellaris.validate` range over its sets, so a check written for `runner` holds for each pool. It sets each field by `set`, never by sprig's `merge`, whose mergo skips empty values: a pool's `replicas: 0` or `tolerations: []` would never apply. A pool's StatefulSet is `<fullname>-runner-<pool>`, refused past 52 characters rather than truncated into another pool's name, and its selector, pod labels, and claim template add `stellaris/runner-pool`, so no pool's selector matches another's pods while the network policy's, without it, matches them all. `enabled`, `serverUrl`, `networkPolicy`, and `pools` are shared, and a pool naming a field `runner` lacks is refused, so a misspelled one never passes as set. With no pools the chart renders `<fullname>-runner` as it always has, byte for byte, so an install that lists none upgrades without change; listing pools removes that StatefulSet, and the chart's README describes how a runner moves into a pool by handing its volume to the claim name its new pod will use before the upgrade.

## Commits, branches, and releases

### Commits follow Conventional Commits and reach `dev` through pull requests

`dev` integrates the work and `main` holds what is released. Both are protected: a change needs a pull request whose CI `check` job is green, and neither branch may be force-pushed or deleted. The rules require `check` by name, so renaming the job or giving it a matrix needs the rules changed before it merges; the `images`, `npm`, and `chart` jobs beside it are not required. A change goes on a branch named `<type>/<slug>` (`feat/`, `fix/`, `refactor/`, `docs/`, `chore/`), and its pull request names `--base dev`, since GitHub's default branch is `main`. After a review and the user's gate, the board lands it as a `ghpr` task (see [landing through a pull request](tasks.md#a-ghpr-task-lands-through-its-pull-request-on-github)), with a merge commit.

A release happens only when the user asks: a `chore(release): x.y.z` commit on `dev` bumps `STELLARIS_VERSION` and the chart's `version` and `appVersion`, a pull request from `dev` into `main` is merged with a merge commit, never squashed or rebased, and a `v<x.y.z>` tag publishes the npm packages and the versioned images (see [images](#images-are-built-from-the-repository-root-and-published-by-ci), [npm](#the-npm-packages-bundle-the-workspace), and [the chart](#the-helm-chart-deploys-the-server-and-runners-when-asked)). The release pull request is merged by hand, since a `ghpr` landing refuses a pull request into any branch but the default one. So `main` holds one merge commit per release that `dev` lacks, with the same files. History up to 0.3.21 is linear: its changes were committed directly, and its releases fast-forwarded `main`.

## Gotchas

### pnpm 12's deploy is not offline

`pnpm fetch` takes no `--frozen-lockfile`, since it always reads the lockfile, and `pnpm install --offline` works from what it fetched, but `pnpm deploy` checks the deployed lockfile against the supply-chain policy (`minimumReleaseAge`), which needs the registry's metadata: run offline, it failed with `ERR_PNPM_NO_OFFLINE_META` for any package whose metadata was not cached. The server's Dockerfile deploys with the network.

### oxfmt reads Helm templates as YAML

A chart's `templates/` hold Go templates, which oxfmt rejects as YAML syntax errors, so `.oxfmtrc.json` ignores `helm/*/templates/**`; `Chart.yaml` and `values.yaml` are plain YAML and stay formatted. `scripts/helm/check.sh`, in `ci.yml`'s `chart` job, checks the templates instead: `helm lint --strict` and `helm template` with the defaults and with values that turn on the runners, the Ingress, and GitHub sign-in, which the defaults leave off, so a template only those render is checked too, and the refusals of `stellaris.validate`; `helm-publish.yml` lints the chart with its defaults before publishing.

### An npm trusted publisher can allow staging without publishing

npm's trust relationships grant `npm publish` and `npm stage publish` separately, and the 0.2.0 release's `npm publish` was refused with `E403 … OIDC permission denied for this action`, after the identity exchange and the provenance signature had both succeeded, because both packages' publishers allowed staging alone. The workflow staged 0.2.0 for a while, then publishing was allowed and it publishes directly again. A staged version takes its version number as a published one does, so a version left staged cannot be published until it is approved or rejected with 2FA, and `npm view` does not see it.
