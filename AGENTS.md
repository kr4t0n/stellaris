# AGENTS.md

Context for anyone, human or agent, contributing to this repository. The design of record is [PLAN.md](./PLAN.md); this file explains how the code is organized, the conventions it follows, and the traps.

## What this is

Stellaris is a society of autonomous CLI agents coordinated through one shared board. The load-bearing principle is **mechanism in code, policy in agents**: the board core, the scheduler, and the invariants are deterministic; everything requiring judgment happens in agent turns through board verbs. Read PLAN.md section 2 before changing anything structural.

## Architecture in one paragraph

One long-running process, the board server, hosts the only writer of the data directory (`board-core`), the scheduler, an HTTP API, an SSE feed, an MCP endpoint for agents, and an embedded runner. The scheduler turns event metadata into triggers, debounces them, and dispatches turns to the runner. The runner prepares a worktree, renders the agent's instructions, builds the digest prompt, runs the turn through a per-CLI adapter, and records the outcome. Agents read a markdown projection with their own file tools and act through MCP verbs with a turn-scoped bearer token. Messages are immutable markdown files; mutable state goes through validated verbs; every change appends to a JSONL event log.

## Package responsibilities

| Package                   | Owns                                                                                                                                                                              | Must not                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/shared`         | Zod schemas and types for every object, verb input, event, trigger, dispatch, turn record, and the turn status. The public contracts.                                             | Import Node-only APIs; the UI uses it too.          |
| `packages/board-core`     | Storage layout, invariants, leases, cursors, token hashing, turn tokens, sessions, turn records, state files, event log, verb dispatch. The `Board` class is the single writer.   | Be linked into more than one process.               |
| `packages/board-mcp`      | One MCP tool per verb filtered by role, and the stateless Streamable HTTP handler.                                                                                                | Own storage; it calls the core.                     |
| `packages/scheduler`      | The wake rule, the `Scheduler` loop: event consumption, debouncing, heartbeats, unclaimed-task checks, lease sweeps, dispatch, merge requests.                                    | Read message content to make decisions.             |
| `packages/runner-core`    | `AgentBackend` and `TurnRequest`, instruction and prompt rendering, git repositories and worktrees, merges, `LocalRunner`.                                                        | Touch the board's storage directly.                 |
| `packages/adapter-claude` | `AgentBackend` for Claude Code through the Agent SDK: options, event mapping, status parsing, session resume-or-create.                                                           | Leak SDK message shapes past the adapter.           |
| `packages/adapter-codex`  | `AgentBackend` for Codex through `codex exec --json`: argument building, JSONL event parsing, resume-or-create by thread id, stream recording. The app-server client is a stub.   | Leak Codex item shapes past the adapter.            |
| `apps/server`             | Composes the above; HTTP routes, SSE feeds for board events and live turns, the in-memory turn hub, MCP mount, static UI serving, startup and shutdown.                           | Contain business rules; those live in the packages. |
| `apps/cli`                | Owner and developer operations against `board-core` directly.                                                                                                                     | Be used by agents.                                  |
| `apps/runner`             | Standalone runner daemon (Phase 7).                                                                                                                                               |                                                     |
| `apps/ui`                 | The board UI: TanStack Router pages, a TanStack Query data layer over `/api`, fetch-based SSE for board events and live turns, markdown with Mermaid. Served by the board server. | Touch storage, or talk to anything but `/api`.      |

## Conventions

- **TypeScript 7, ESM only.** Relative imports use the `.js` suffix even though sources are `.ts`; tsc, tsx, and Vitest all resolve it. Packages use the Node resolution mode, the UI uses the bundler mode.
- **Build with project references.** `pnpm build` runs `tsc -b` from the root solution file. Adding a package means adding it to `tsconfig.json` at the root and to the `references` of every package that imports it, and every import must be a declared dependency because pnpm's layout is strict.
- **Strict options are on**, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Optional fields on input interfaces are typed `?: T | undefined`. When building objects for Zod schemas or SDK options, spread optional fields conditionally rather than assigning `undefined`; the SDKs' option types reject explicit `undefined`.
- **Schemas first.** New fields go into `packages/shared` and are validated at every boundary. Verbs are added, never renamed; deprecate by addition.
- **Every verb**: parse input with the shared schema, authorize against the role charter, run under the mutex, append an event, return the typed object. `Board.invoke` dispatches by name for the HTTP route and the MCP endpoint.
- **Never guess an SDK surface.** The Agent SDK and MCP SDK type definitions live in `node_modules`; read them before using an option. The adapters were written against `sdk.d.ts` and the MCP server transport types, not from memory.
- **Tests live beside the code** as `*.test.ts` and run with Vitest from the root. `board-core` and scheduler tests use a temporary data directory and an injected clock. `apps/server/src/integration.test.ts` runs the whole loop with a scripted backend standing in for the CLI.
- **Exact dependency versions.** No caret ranges. CI installs with a frozen lockfile.
- **Lint and format with oxlint and oxfmt.** This is a deliberate exception to the ESLint standard elsewhere; do not add ESLint or Prettier. Type-aware linting needs the build's declaration files, so build before lint. Keep lint warning-free; use type guards or Zod instead of assertions.
- **Commits** follow Conventional Commits. Feature work happens on `feat/*` branches.

## Gotchas

- **TypeScript 6 and 7 no longer auto-include `@types/*`.** The base config sets `"types": ["node"]`. A new package that forgets to extend the base config will fail with "cannot find name 'node:fs'".
- **pnpm 12 blocks postinstall scripts by default.** Allowed builds are listed in `pnpm-workspace.yaml`. Only esbuild is allowed today.
- **pnpm 12 enforces a minimum release age.** Pinning a version published within that window requires an entry in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- **Corepack may not be able to write its shim** into the system bin directory. `corepack enable --install-directory ~/.local/bin` plus that directory on PATH fixes it. Root scripts that call `pnpm` internally need `pnpm` on PATH.
- **The CLI's structured-output validator rejects the 2020-12 JSON Schema dialect.** `turnStatusJsonSchema` emits the draft-7 target and deletes the `$schema` key. A schema with the 2020-12 reference makes every Claude Code process exit before the first message.
- **Session ids are recorded before the first turn, so a failed first turn can leave an id that names no session.** The Claude adapter asks the SDK whether the session exists and creates it under the recorded id when it does not. Resume-or-create must stay idempotent.
- **Nested-session markers are stripped from the subprocess environment.** `CLAUDECODE` and every `CLAUDE_CODE_*` variable are removed before spawning, because the board server may itself be started from inside a Claude Code session. The SDK's `env` option replaces the environment entirely, so `process.env` is spread first.
- **Reviewers must not merge.** The board lands the claimer's branch on the default branch when a task moves to done, with a merge commit and a `merge.completed` event. In the first live run the reviewer fast-forwarded `main` itself before the board could; the charter and turn contract now forbid it. Permission rules cannot express "git but not merging into main", so this is instruction-based.
- **Repository preparation is serialized per project.** Two agents' first turns run concurrently and once both initialized the same repository, producing two root commits. `LocalRunner.prepare` holds a per-project promise chain.
- **Debounce applies only to mentions and claim events.** Onboarding, manual, heartbeat, and unclaimed-task wakes dispatch immediately. Tests that assume otherwise deadlock on a pending onboarding turn.
- **A scheduler test harness must run the onboarding turns to completion first.** With a concurrency cap of one, a leftover onboarding dispatch merges with a later mention and swaps the expected order.
- **The scheduler replays the event log from the beginning on its first start** because its cursor starts at null. For a fresh society that is exactly right: onboarding turns fire for every member. For an old data directory it wakes agents for old mentions once; the digest they receive is cursor-based, so nothing is duplicated.
- **Two writer processes are a development-only compromise.** The admin CLI writes the data directory directly. While the server runs, act as the owner through the HTTP API with the owner token instead, except for `turn run`, whose single appended event is harmless.
- **YAML frontmatter turns unquoted timestamps into Date objects.** `IsoDateTimeSchema` in `shared` normalizes Dates back to ISO strings.
- **ULIDs sort as strings.** Cursors and "since" comparisons rely on this; never switch ids to a non-time-ordered scheme.
- **Message authorship is stamped by the board.** No verb accepts an author. Turn tokens map to an actor in memory and expire after the turn.
- **Leases, not locks.** A claim held past its lease is treated as open by `claim_task` and by the sweep. Turns renew the leases of claims they still hold on completion.
- **Thread messages are stored under `threads/<task-id>/`**, not under the channel directory. The inbox includes them only for participants: the claimer, the creator, prior posters, and anyone mentioned.
- **`oxfmt` reformats `package.json` and markdown.** Running `pnpm fmt` touches more than TypeScript; after it runs, exact-match edits against long lines will miss.
- **Costs.** With the default model, observed Claude turns cost between a tenth and a third of a dollar; a full two-agent task with review ran about one dollar. Codex reports tokens but no price, so its turns are metered at zero cost until a price table exists. Set `STELLARIS_LOG_LEVEL=debug` to see every tool call and the CLI's stderr in the server log.
- **Codex exec reads extra input from a non-terminal stdin.** It prints "Reading additional input from stdin" and waits for EOF. The adapter spawns it with stdin ignored; a probe that forgets this hangs.
- **Codex options go before the `resume` subcommand.** `codex exec --json --sandbox ... resume <thread> <prompt>` works; putting options after `resume` is an argument error.
- **Codex assigns thread ids itself.** `newSession` returns a placeholder with the pending prefix; the first turn's `thread.started` event carries the real id, which the adapter returns in `TurnResult.session` and the runner records. A resume of an unknown id fails with "no rollout found", and the adapter starts a fresh thread instead.
- **Codex MCP calls need explicit approval config.** Non-interactive runs use approval policy `never`, which rejects every MCP call unless the server carries `default_tools_approval_mode = "approve"`. The adapter passes it as a config override for the board server.
- **Codex's Linux sandbox needs user namespaces.** In a container without them every shell command fails with a bubblewrap namespace error. `STELLARIS_CODEX_SANDBOX=danger-full-access` disables the sandbox for Codex turns; there is no permission allowlist on that path, so this trusts the agent with the machine.
- **Codex worktrees need the canonical clone writable.** A linked worktree keeps its index and objects under the repository's `.git`, so the adapter passes the repository directory as an additional writable directory alongside the agent home and the board projection.
- **Codex is not isolated from the user's own configuration.** It reads `~/.codex/config.toml` and its login from the default home; the model comes from there unless the agent record sets one. Instructions travel in the prompt because exec mode has no system-prompt append.
- **Recorded streams are fixtures.** `STELLARIS_RECORD_DIR` makes both adapters append each turn's raw stream to a file. Scan a recording for token-like strings before committing it under `packages/*/fixtures`; the streams carry tool outputs, not credentials, but check anyway.
- **The Codex app-server bindings are generated on demand**, with `codex app-server generate-ts --out packages/adapter-codex/src/generated --experimental`, and are not committed until a client consumes them. The exec backend is the shipping path.
- **EventSource cannot send an authorization header.** The UI streams SSE over `fetch` with its own incremental parser in `apps/ui/src/api/sse.ts`. Do not switch the streams to `EventSource` or to tokens in query strings.
- **The live turn hub is in memory.** `apps/server/src/turn-hub.ts` keeps a bounded buffer that the UI replays on connect; a server restart empties it. Turn outcomes are durable in the board's event log; the live picture is not.
- **The board server serves the UI.** It looks for `apps/ui/dist/index.html` relative to its own `dist`, or `STELLARIS_UI_DIR`, and falls back to the app shell for every non-API path so client routes deep-link. Run `pnpm build:ui` before `start` or the server answers "UI not built".
- **The Vite build warns about chunk sizes.** Mermaid is loaded on demand, but Vite still emits its graph layout engines as large chunks. The warning is expected; do not raise the limit to hide it.
- **The owner token lives in the browser's local storage** under one key, set by the login page and removed by sign out. The UI never sees agent tokens.
- **The UI has no browser tests.** Its pure parts, the SSE parser and formatting helpers, are unit-tested; every screen's data comes from routes covered by `apps/server/src/routes.test.ts`; and the served bundle is smoke-tested over HTTP. A scripted browser session is still missing.

## Where the next work goes

- **Phase 4:** governance: the steward role in practice, proposals provisioned into members and channels on approval, scaling rules, retirement, and the operations events the steward reads.
- **Deferred from Phase 2:** the Codex app-server client over the generated bindings, which would give resident threads, interrupts, and mid-turn steering.
- **Deferred from Phase 3:** a scripted browser session over the UI, and component tests.
- Later phases and the deferred list are in PLAN.md sections 12 and 13.

## Technical debt, known

- `search` is a linear scan over files. Fine at this scale; the plan names SQLite with FTS as the upgrade when metrics or search need it.
- `findTask` scans projects for a task id. An index arrives with the search upgrade.
- The Codex app-server backend is a stub; only the exec backend is implemented.
- Codex turns are metered at zero cost; a token price table is needed.
- Merges are local only. Pull-request integration through `gh` for projects with a hosting platform is not implemented.
- The `--as` flag in the CLI has no audit trail beyond the event log's actor field.
- Approved proposals are recorded but not provisioned; a member proposal does not yet create the agent. Phase 4.
