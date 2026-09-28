# AGENTS.md

Context for anyone, human or agent, contributing to this repository. The design of record is [PLAN.md](./PLAN.md); this file explains how the code is organized, the conventions it follows, and the traps.

## What this is

Stellaris is a society of autonomous CLI agents coordinated through one shared board. The load-bearing principle is **mechanism in code, policy in agents**: the board core, the scheduler, and the invariants are deterministic; everything requiring judgment happens in agent turns through board verbs. Read PLAN.md section 2 before changing anything structural.

## Architecture in one paragraph

One long-running process, the board server, hosts the only writer of the data directory (`board-core`), the scheduler, an HTTP API, an SSE feed for the UI, an MCP endpoint for agents, and an embedded runner. Runners on other machines connect outbound and execute dispatched turns through per-CLI adapters. Agents read a markdown projection with their own file tools and act through MCP verbs with a bearer token. Messages are immutable markdown files; mutable state goes through validated verbs; every change appends to a JSONL event log.

## Package responsibilities

| Package                | Owns                                                                                                           | Must not                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/shared`      | Zod schemas and types for every object, verb input, event, and the turn status. The public contracts.          | Import Node-only APIs; the UI uses it too.          |
| `packages/board-core`  | Storage layout, invariants, leases, cursors, token hashing, event log. The `Board` class is the single writer. | Be linked into more than one process.               |
| `packages/board-mcp`   | One MCP tool per verb, filtered by role.                                                                       | Own storage; it calls the core.                     |
| `packages/scheduler`   | Wake rules, limits, timings. Pure functions today.                                                             | Read message content to make decisions.             |
| `packages/runner-core` | `AgentBackend` interface, config-home rendering, later worktrees and the projection mirror.                    | Touch the board's storage.                          |
| `packages/adapter-*`   | One `AgentBackend` per CLI.                                                                                    | Leak CLI-specific event shapes past the adapter.    |
| `apps/server`          | Composes the above into the board server.                                                                      | Contain business rules; those live in the packages. |
| `apps/cli`             | Owner and developer operations against `board-core` directly.                                                  | Be used by agents.                                  |
| `apps/runner`          | Standalone runner daemon (Phase 7).                                                                            |                                                     |
| `apps/ui`              | React views over the HTTP API and SSE (Phase 3).                                                               | Touch storage.                                      |

## Conventions

- **TypeScript 7, ESM only.** Relative imports use the `.js` suffix even though sources are `.ts`; tsc, tsx, and Vitest all resolve it. Packages use the Node resolution mode, the UI uses the bundler mode.
- **Build with project references.** `pnpm build` runs `tsc -b` from the root solution file. Adding a package means adding it to `tsconfig.json` at the root and to the `references` of every package that imports it.
- **Strict options are on**, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Optional fields on input interfaces are typed `?: T | undefined` so callers can pass `undefined` from parsed options. When building objects for Zod schemas, spread optional fields conditionally rather than assigning `undefined`.
- **Schemas first.** New fields go into `packages/shared` and are validated at every boundary. Verbs are added, never renamed; deprecate by addition.
- **Every verb**: parse input with the shared schema, authorize against the role charter, run under the mutex, append an event, return the typed object.
- **Tests live beside the code** as `*.test.ts` and run with Vitest from the root. `board-core` tests use a temporary data directory and an injected clock.
- **Exact dependency versions.** No caret ranges. CI installs with a frozen lockfile.
- **Lint and format with oxlint and oxfmt.** This is a deliberate exception to the ESLint standard elsewhere; do not add ESLint or Prettier. Type-aware linting needs the build's declaration files, so build before lint.
- **Commits** follow Conventional Commits.

## Gotchas

- **TypeScript 6 and 7 no longer auto-include `@types/*`.** The base config sets `"types": ["node"]`. A new package that forgets to extend the base config will fail with "cannot find name 'node:fs'".
- **pnpm 12 blocks postinstall scripts by default.** Allowed builds are listed in `pnpm-workspace.yaml`. Only esbuild is allowed today. A new dependency with a build script fails install until listed there; decide deliberately.
- **pnpm 12 enforces a minimum release age.** Pinning a version published within that window requires an entry in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. pnpm writes the suggestion for you; keep the file tidy.
- **Corepack may not be able to write its shim** into the system bin directory. `corepack enable --install-directory ~/.local/bin` plus that directory on PATH fixes it. `corepack pnpm <command>` works for single commands, but root scripts that call `pnpm` internally, such as `check` and `build:ui`, need `pnpm` on PATH.
- **YAML frontmatter turns unquoted timestamps into Date objects.** `IsoDateTimeSchema` in `shared` normalizes Dates back to ISO strings. gray-matter quotes them on write, so this only matters for hand-edited files.
- **ULIDs sort as strings.** Cursors and "since" comparisons rely on this; never switch message ids to a non-time-ordered scheme.
- **Message authorship is stamped by the board.** No verb accepts an author. The CLI's `--as` flag resolves an actor through the library because it is a trusted development tool; the MCP endpoint will resolve actors from bearer tokens.
- **Leases, not locks.** A claim held past its lease is treated as open by `claim_task` and by the `expireLeases` sweep. Tests use a 60 second lease with an injected clock.
- **Thread messages are stored under `threads/<task-id>/`**, not under the channel directory, even though their frontmatter carries the channel. The inbox includes them only for participants: the claimer, the creator, prior posters, and anyone mentioned.
- **`oxfmt` reformats `package.json` and markdown.** Running `pnpm fmt` touches more than TypeScript; that is expected.
- **The Vite UI is type-checked by `tsc -b` but bundled separately** with `pnpm build:ui`. Tailwind v4 reads design tokens from `tailwind.config.ts` through the `@config` directive in `src/index.css`.

## Where the next work goes

- **Phase 1:** mount the MCP Streamable HTTP endpoint and the verb routes in `apps/server`, resolve actors from tokens, implement the scheduler loop and dispatch, the embedded runner, and the Claude adapter through the Agent SDK. `stellaris turn run` becomes real.
- **Phase 2:** Codex app-server adapter with generated bindings, the exec fallback, recorded fixtures.
- **Phase 3:** the three UI views over the API and SSE.
- Later phases and the deferred list are in PLAN.md sections 12 and 13.

## Technical debt, known

- `search` is a linear scan over files. Fine at this scale; the plan names SQLite with FTS as the upgrade when metrics or search need it.
- `findTask` scans projects for a task id. An index arrives with the search upgrade.
- Adapters are interface stubs that reject every call until their phase.
- The `--as` flag in the CLI has no audit trail beyond the event log's actor field.
