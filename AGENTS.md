# AGENTS.md

The rules for anyone, human or agent, changing this repository. Coding agents load this file into every session, so it holds what applies everywhere and links the rest. Setup, commands, and configuration are in the [README](./README.md). The detail behind each rule is in [docs/internals](./docs/internals/), one page per area, with the incidents that shaped it; read the page before changing its area. The design record, with the rationale and the decision register, is [docs/plan.md](./docs/plan.md).

## What this is

Stellaris is a society of autonomous CLI agents coordinated through one shared board. The load-bearing principle is **mechanism in code, policy in agents**: the board core, the scheduler, and the invariants are deterministic; everything requiring judgment happens in agent turns through board verbs. Read [docs/plan.md section 2](./docs/plan.md#2-design-principles) before changing anything structural.

## Architecture in one paragraph

One long-running process, the board server, hosts the only writer of the data directory (`board-core`), the scheduler, an HTTP API, an SSE feed, an MCP endpoint for agents, and the hub runners connect to; it runs no turns. The scheduler turns event metadata into triggers, debounces them, and dispatches turns through the hub, which places each on a runner, the one its project lives on, and hands the runner a self-contained job that `turn-host` built: the rendered instructions, the digest prompt, the turn token, the limits, and the workspace. A runner is a process of its own on every machine, the server's included; it pulls the agent's home and the board's projection, prepares the worktree, runs the turn through a per-CLI adapter, pushes the home back, and reports the outcome, which the server records. Agents read a markdown projection with their own file tools and act through MCP verbs with a turn-scoped bearer token. Messages are immutable markdown files; mutable state goes through validated verbs; every change appends to a JSONL event log. Governance closes the loop: the scheduler also computes operations signals from board state on a cadence and logs them as events, a steward agent reads them in its prompt and turns them into proposals, and approval provisions the proposal inside the board's transaction, so hiring, channels, charters, and retirement never leave the board.

## Packages

- `packages/shared`: Zod schemas and types for every object, verb input, event, trigger, dispatch, turn record, and the turn status, the public contracts. Imports no Node-only API, since the browser imports it too.
- `packages/board-core`: the `Board` class, the single writer: storage, invariants, leases, cursors, tokens, sessions, turn records, the event log, verbs, task plans and completion, provisioning, archives, runner records, sign-ins, knowledge, dashboards, skills, crons, images, search. Linked into one process only.
- `packages/board-mcp`: one MCP tool per verb, filtered by role, and the stateless Streamable HTTP handler. Owns no storage; it calls the core.
- `packages/scheduler`: the wake rule and the `Scheduler` loop: events to wakes, debouncing, heartbeats, waiting stages, reflection, crons, operations signals, scaling, spend reports, lease sweeps, dispatch, the completion queue. Never reads message content to decide.
- `packages/turn-host`: the server side of a turn. `TurnHost` builds a dispatch into a job and records its outcome; `RunnerHub` registers runners, places turns, steers and stops them, lands tasks, and reads branches, images, and model lists for the server. Prompt and instruction rendering. Never touches a runner's disk or runs a CLI.
- `packages/runner-core`: the runner side of the protocol: `AgentBackend`, `TurnControl`, `TurnExecutor` (worktrees, sessions, the hand-back, landing, reads), git, `TreeCopy`, `RunnerClient`, `RunnerDaemon`, enrollment. Never imports `board-core` or reaches the server but by the protocol.
- `packages/adapter-claude` and `packages/adapter-codex`: an `AgentBackend` each, Claude Code through the Agent SDK and Codex over `codex app-server`. Neither leaks its CLI's message shapes past it.
- `apps/server`: composes the packages: HTTP routes, the runner protocol under `/runner`, GitHub sign-in under `/auth`, enrollment, the event and turn streams, the MCP mount, the built interface. Holds no business rule and runs no turns; `src/testing` holds the scripted backend and the test harness.
- `apps/web`: the playground: the sky, the board's islands, and citizens' live turns, over the HTTP API and the two streams. Holds no state the board lacks and writes only through verbs.
- `apps/cli`: user and developer operations against `board-core` directly. Never used by agents.
- `apps/runner`: the runner daemon: configuration, its token or enrollment, both adapters, and `createRunner`; one per machine, the server's own included.
- `apps/ios`: the native client. `Stellaris`, the SwiftUI app: sign-in, settings, the tabs of Chat, Board, and Needs you, and the sky beside them on the inner display, its project generated by XcodeGen from `project.yml`. `BoardKit`, a Swift package: models, request builders, the event-stream parser, the app's GitHub sign-in, a message's markdown read with swift-markdown, its one dependency, and ports of the web's `staleKeys`, `needsYou`, `postedLine`, `withTitles`, link rules, and the sky's model, camera, and scene in Foundation alone, and a `URLSession` transport with the token in the Keychain. Beside them, the fixtures the server's tests capture and the tables the web's sky tests write. No `package.json`, so pnpm leaves it alone.

## Decisions

- **Full autonomy.** Adapters grant every permission and never route a decision to a human: Claude Code runs in `bypassPermissions`, Codex with sandbox `danger-full-access` and approval `never`. A sandbox, a permission mode, or a command allowlist is an adapter option for a runner that needs one, never a society setting or a default ([permissions](./docs/internals/adapters.md#permissions)).
- **One writer.** `board-core` in the server's process is the only writer of the data directory. The admin CLI writing it directly is a development compromise: while the server runs, act as the user through the HTTP API, except for `turn run`.
- **The server runs no turns.** Every turn runs on a runner over the protocol of [docs/plan.md section 7.1](./docs/plan.md#71-the-runner-protocol). Keep the three decisions of section 7.3 that keep later extensions additive: the job names where the code is, the outcome reports the branch and commit it left, and landing is one interface.
- **Verbs are added, never renamed**; deprecate by addition. `read_inbox` keeps its old name for that reason.
- **Tokens, never dollars, in the interface.** Codex reports no price, so its turns are unmetered, not free; the board still records Claude's `costUsd` for the spend report and the `turn_cost` signal.
- **oxlint and oxfmt, not ESLint or Prettier.** Exact dependency versions, never a caret range; CI installs with a frozen lockfile.

## Conventions

### Code and build ([delivery.md](./docs/internals/delivery.md#the-toolchain))

- TypeScript 7, ESM only. Relative imports use the `.js` suffix; packages use the Node resolution mode.
- `pnpm build` and `pnpm typecheck` both run `tsc -b` over the root solution, since TypeScript refuses `--noEmit` for a referenced project (TS6310). A new package goes into the root `tsconfig.json` and the `references` of every package that imports it, and every import must be a declared dependency, since pnpm's layout is strict.
- Strict options include `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Optional input fields are `?: T | undefined`, and objects for Zod schemas or SDK options spread optional fields conditionally rather than assigning `undefined`.
- Schemas first: a new field goes into `packages/shared` and is validated at every boundary ([board.md](./docs/internals/board.md#schemas-first)).
- Never guess an SDK surface: read the Agent SDK's and the MCP SDK's type definitions in `node_modules` first ([adapters.md](./docs/internals/adapters.md#never-guess-an-sdk-surface)).
- Build before lint, since the type-aware rules need the declaration files. Keep lint warning-free, with type guards or Zod instead of assertions.
- `.husky/pre-commit` runs gitleaks on what is staged. Where husky is off (`HUSKY=0`, as on every runner), run `gitleaks git --pre-commit --staged --redact --no-banner` yourself before each commit; a verified false positive goes in `.gitleaks.toml`.
- `CLAUDE.md` holds only `@AGENTS.md`. Claude Code loads `AGENTS.md` by itself only where no `CLAUDE.md` exists, so anything added to `CLAUDE.md` must keep that line.

### Board core ([board.md](./docs/internals/board.md))

- Every verb parses its input with the shared schema, authorizes against the role charter, runs under the mutex, appends an event, and returns the typed object; `Board.invoke` dispatches by name for HTTP and MCP. A read that scans many files holds the mutex only for a snapshot (`digestSnapshot`), and files are written through `writeFileAtomic`.
- `/mcp` reads at most 1 MiB a request and 1,000 array elements and object members a tool call (`MAX_REQUEST_BODY_SIZE` and `MAX_TOOL_INPUT_ELEMENTS` in `board-mcp`, for GHSA-46jr-4wx8-v453). A verb whose input could need more raises them with a measurement.
- The board stamps every message's author; no verb takes one. Ids are ULIDs from one monotonic source, and cursors and "since" comparisons rely on their sorting as strings.
- A thread is a record off a channel (`threads/<id>.md`, its messages in `threads/<id>/`). A task's or a proposal's thread takes its subject's id. Participants are derived, never stored.
- A mention is an `@name` outside code, found by `mentionsIn` (`@stellaris/shared/mentions`) with micromark and GFM without autolink literals and footnote calls. `postMentions` bounds the parse to 500 ms in a `vm`, past which every name counts. Never write an `@` into a post the board authors: it would wake whoever it names.
- `refreshMember` rewrites a citizen's roster entry; call it in any new path that changes an agent record, a claim, a task outcome, or a turn record.
- Memory reaches a turn only as rendered instructions (`renderInstructions`: the charter, the norms, `memory/core.md`, and a skills index); neither CLI's own discovery is relied on. What a citizen writes (profile, memory, skills, dashboards) is read with `readLooseMarkdown`, which never throws.
- `search` never reads another citizen's home; a new search source must keep that.
- Knowledge and dashboards change only through verbs, over the revision the caller read. Skills are folders in a citizen's home and reach the society only through a `skill` proposal, which publishes the copy taken when the proposing turn ended.
- A cron is a five-field expression, read in its own zone or the society's, or one `at`, firing at most every 15 minutes. Its next fire is computed, never stored, and it ends with its conversation.
- Every turn keeps its steps in `agents/<name>/turns/<turn id>.jsonl`, each tool output cut to its first and last 2,000 characters by `capOutput`. A citizen's tokens are summed from the event log, and a turn without a count is unknown, never zero.
- An uploaded image is checked by the runner (a path in the turn's worktree, the citizen's home, or the temp folder; PNG, JPEG, GIF, or WebP; at most 8 MB) and again by the board, which keeps it outside the projection under `images/`.

### Conversations and wakes ([conversations.md](./docs/internals/conversations.md))

- A session is a conversation: the home (a place's `general` and work tied to nothing else), one per other channel, one per project asked in while not a member (in the society scope), and one per thread. `sessionKey` spells it (`agent/scope`, `agent/scope/thread`, `agent/scope/#channel`, `agent/society/~project`), and the scheduler, the runner's warm sessions, and the interface all key by it. Each has its own digest, cursor, session, and workspace.
- The runner reads a conversation's digest without advancing it and moves the cursor only after the turn ends; a cursor never moves back. A new thread conversation is shown the whole thread.
- A turn happens where it was asked: `wakeScope` gives the message's project when the citizen belongs to it, else the society scope.
- Direct wakes always fire: a mention, a stage becoming current, a finished task for its creator, a decided proposal for its proposer, onboarding, manual, reflection, closing, and cron wakes. `wakeTriggers` opts into the ambient ones, `user_post`, `ops_event`, and `heartbeat`, and none listed means the heartbeat. A heartbeat wakes only a conversation with unread posts or a stage to hold, where posts by the board, task steps, and posts in closed threads never count. A blocked task wakes nobody until its last blocker ends.
- User posts wake the front desk only (`user_post`), at user priority with no debounce. Mentions, stage, finished-task, and signal wakes are debounced; onboarding, manual, heartbeat, and reflection wakes dispatch at once.
- No conversation ends under another citizen's turn: `assertNoTurnCut` refuses closing, archiving, abandoning, deciding, and the last advance of a `none` task while someone else is in a turn there.
- A mention or a user post for a running conversation is steered into its turn. The user may stop a turn, which counts as a decision, not a failure.
- A turn whose record is `transient`, turned away by the model service for now, goes again as the same queued wake after each delay of `transientRetryMs` (1, 3, then 10 minutes), unless a wake is queued there already; then the heartbeat takes over and a `turn_refused` signal, which wakes nobody, says so. Nothing switches a member's model.
- Reflection runs per member on a cadence, in its latest working turn's scope, skips a member that has not worked since, and holds the member's other turns while it runs.
- A question to the user is an `@user` where it belongs. A turn reporting `needsUserDecision` that asked nowhere gets its summary posted as the question.

### Tasks and landing ([tasks.md](./docs/internals/tasks.md))

- A task is a plan of stages; the core knows only `open`, `claimed`, `done`, and `abandoned`, and no role or stage name. `mayHoldStage` is the one eligibility rule, a stage may name only an active member of the project or the user, and only `PLANNING_ROLES` touch a gate or the completion effect (`gateChanges`).
- A task's thread opens with the task and closes only with it. The notes of `advance_task` and `update_task` are posted there as steps, which wake only through their stage wake.
- `holders` is history; `claimedBy` is the current holder. A send-back sets `returned` until the work reaches that stage again.
- Completion is a queued effect: the last advance of a `merge` or `ghpr` task sets `completing`, the scheduler waits for the turns in the task's thread, the runner lands it, and `finishCompletion` marks it done or reopens its last stage.
- A `ghpr` task lands the pull request linked with `update_task` `pull_request`, with a merge commit and `--match-head-commit`, only when its files equal `task/<id>`'s. Abandoning one closes the pull request and drops its branch.

### Workspaces and git ([workspaces.md](./docs/internals/workspaces.md))

- Every conversation works in a place of its own on its runner: a task's worktree (`.tasks/<id>`), a proposal's or a topic's (`.threads/<id>`), a channel's (`.channels/<project>/<channel>`), the home worktree on `agent/<name>`, and scratch folders outside projects. Each goes when its conversation ends.
- The stage's holder has the task's branch to itself; anyone else's turn works detached at its tip. After every turn the runner commits what was left as the citizen, with `--no-verify`, detaches, and moves the branch on to commits made beside it when a fast-forward takes them (`settleTaskBranch`); what none takes is reported in the task's thread, never dropped.
- Code keeps current what holds no one's work (`syncRemote`, `followBase`, `fastForwardWorktree`, `refreshDetached`) and never merges or commits for an agent. What it left alone, and why, goes into the prompt under **Your workspace**.
- In a `merge` or `ghpr` project only the runner moves the default branch: its `reference-transaction` and `pre-push` hooks in the clone refuse anything else. It clears a `core.hooksPath` in the clone's `.git/config` and moves foreign hooks of those names aside, so the guard runs, and every CLI runs with `HUSKY=0` (`CLI_ENV`), so husky's hooks never do.
- The runner gives the CLIs no git identity: a citizen's own commits carry the runner account's global one, which `GitIdentityCheck` reports when missing. Git work on a project's clone is serialized by `withProjectLock`.
- Work on no branch is reported as `leftovers`; a conversation that ended with them gets up to three closing turns before its workspace stays.
- Homes are git repositories that the server serves through `git http-backend` and writes no tracked file in after creating them. Pushes are fast-forwards checked by a pre-receive hook, one per home at a time, and a file over 8 MB never enters history. Turns of one citizen share one copy: change a file there with the edit tool, never by rewriting it whole from an earlier read.

### Runners and adapters ([runners.md](./docs/internals/runners.md), [adapters.md](./docs/internals/adapters.md))

- A project lives on the runner that took its first turn; a citizen's society-scope turns go to its pinned `homeRunner`. A turn no runner can take stays queued.
- A job is self-contained, and the board never sees a path: places travel as `PATH_TOKENS`, `WORKSPACE_TOKEN`, and `SERVER_TOKEN`, which the runner fills.
- Every route that reads a request body caps it with `limitBody` (`apps/server/src/body-limit.ts`): 16 KiB on the two enroll routes and the app's code exchange, which take no token, 1 MiB on a write under `/api`, as on `/mcp`, 8 MiB on a runner's posts, and 16 MiB on its answers, which carry files and images as base64. A 413 closes the connection; a runner that reads it posts the body no more, and one still uploading may see a reset instead and post a few times more. So a new route that reads a body takes a limit far above its largest real one ([body limits](./docs/internals/runners.md#every-route-that-reads-a-request-body-caps-it)). The home's git route reads a pack whole and refuses one over 256 MiB only once it has it.
- A GitHub sign-in lands only on a path on the board, which `safeNext` rebuilds from `next` as `URL` resolves it, since a browser drops tabs and newlines before it parses an address; nothing in a request names a scheme or a host to land on, and no custom scheme is ever a landing. The app's sign-in (`landing=app`), refused with a 403 unless `STELLARIS_APPLE_APP_ID` names the app, starts with a PKCE challenge and lands at `APP_LANDING`, an `https` path on the board fixed in `github-auth.ts`, with a one-time code the app trades with its verifier at `/auth/app/token`; Apple's association file names the app, so no other app can take the landing ([GitHub sign-in](./docs/internals/runners.md#github-sign-in)).
- Both ends check the stream: the server writes every 15 s, the runner drops a stream silent for 45 s, every job is acknowledged and an unacknowledged one is sent again, and steps and outcomes are posted again for up to 15 minutes.
- Only the server starts a conversation's session afresh. An adapter resumes the saved session or fails the turn before any model call with `resumeFailed`; the host drops a `lost` session at once and a `retry` one after three such turns.
- Residency is a runner mechanism: one warm session per home conversation for `resident` charters, started afresh when the citizen's memory, model, or effort changes, when a turn fails, or when the server no longer knows its token.
- A citizen's model and effort are settings, chosen from the list the CLI gives on the citizen's runner.
- A CLI's quota is what its login reported, kept on the runner's record (`CliQuota`) and built field by field, so nothing else a CLI sends leaves the adapter. A report outside the schema is dropped, never the turn, and nothing may trigger Claude Code's billed `quota_check`.
- An adapter marks a turn `transient` only for a failure on the model service's side once the CLI's own retries ran out: Codex's `codexErrorInfo` by `isTransient`, Claude's `api_error_status` 5xx or 529. A plan's usage limit, the context window, a policy, a sign-in, or another 4xx is not ([refusals](./docs/internals/adapters.md#a-turn-the-model-service-turned-away-for-now-is-transient)).
- Both adapters strip `CLAUDECODE` and every `CLAUDE_CODE_*` variable from the CLI's environment and set `HUSKY=0`. Every Codex turn runs over `codex app-server`, with `default_tools_approval_mode = "approve"` so MCP calls pass.
- A fake that streams Claude input must echo the user messages it takes, as the CLI does with `--replay-user-messages`: a turn ends only at a result after the prompt's echo.

### Governance ([governance.md](./docs/internals/governance.md))

- Work roles are not seeded: a society starts with the user, the steward, and the concierge, and tests write the roles they need (`addWorkRoles`).
- A proposal is checked when filed and again at approval, which provisions it in the same transaction. It is a thread in `governance`, and its decision wakes the proposer in the conversation it was filed from. A new kind needs a charter schema, a `describeCharter` line, a validator, a provisioner, an approver list, and a drawing in `ProposalCharter.tsx`; approvers are read through `proposalApprovers`.
- A charter change reaches its members' `role.md` through `writeRoleUnlocked`. `wakeTriggers` lists only the three ambient wakes.
- A society role (`societyScope`) is never in a project. Work roles work in projects and are asked anywhere.
- Signals are counters or timers, keyed, and logged as `ops.signal` events, never posted. Only `WAKING_SIGNAL_KINDS` wake `ops_event` roles, and a persisting condition only on the logs the operations pass marks `wakes` (new, an idle member's steps, churn rising, daily for the rest), read through `signalWakes`. A reader's prompt lists each key once and sums the hourly spend reports into one line. A summary may quote metadata, never a message body.
- A project starts with `general` alone and ends by archive, never by deletion. A channel beside `general` is a workstream the planners open and archive, followed by choice.
- A one-time migration of stored data is an alignment `Board.open` applies once and records in `state/alignments.json`. It goes, with the reader of the old shape, once every board has applied it; none is pending.

### Interface ([interface.md](./docs/internals/interface.md))

- The sky is a projection: `skyModel` decides every anchor, star, and state, purely, and `SkyScene` only eases and draws. A new element of the sky is a field on the model.
- The board is islands over the sky, and every view is an address: routes are code-based in `router.ts`, views are lazy, and server state lives in TanStack Query.
- An event refreshes what it touched: `staleKeys` in `lib/events.ts` maps each event type to the query keys it makes stale, so a new query whose data an event can change needs an entry there.
- Live turns are a projection of the turn stream (`LiveStore`, `applyLive`), keyed like the scheduler's sessions, and a stored transcript folds through the same `applyLive`.
- A new write the interface makes needs a fake in `apps/web/e2e/board.ts`.
- What needs the user is derived, never stored.
- Ids and worktree paths in text read as what they name (`entityIndex`, `linkTarget`), and an uploaded image is `image:<id>`.
- The look is argus's: theme tokens in `@theme` in `styles.css`, mirrored at the top of `scene.ts`; one type ladder (`text-heading`, `text-section`, `text-sm`, `text-meta`, and `text-caps` for field labels only); monospace only for code. Every composer is one row. Views explain themselves through headings, labels, values, and states, with no intro lines ([the rule](./docs/internals/interface.md#views-carry-no-intro-lines)).

### The iOS client ([ios.md](./docs/internals/ios.md))

- BoardKit's core imports Foundation alone and passes `swift test` on Linux; what needs Apple's frameworks goes in `Transport/`, behind `#if canImport(Darwin)` or `Security`.
- Its models hold the fields of the schemas in `packages/shared` that the app reads, with the schemas' names and defaults; ids and times stay strings, a value of a closed set is an `OrUnknown` and a message's step or notice of a shape it doesn't know is `unknown`, so what a newer server adds leaves the answer readable, and a name Swift or Foundation already uses takes a `Board` prefix.
- `apps/server/src/ios-fixtures.test.ts` captures every answer the client reads into `apps/ios/fixtures/api`, so a server change that alters one fails `check` until it is captured again with `-u`. A request the app starts to make gets a capture there and a check in BoardKit's `FixtureTests`.
- A change to the web's `staleKeys`, `needsYou`, `postedLine`, `withTitles`, or where a message's link goes (`urlTransform`, `entityOfHref`, `linkTarget`) changes its case table in `apps/ios/fixtures/cases`, and its Swift port with it.
- A message is read as the web's `Markdown` reads it, into BoardKit's `MessageDocument`: GitHub's markdown with literal autolinks, known ids as links named by their titles, mentions outside code and links, raw HTML as written, and unsafe addresses dropped; the app draws its blocks in the web's type, Instrument Sans in `Stellaris/Fonts` under the SIL OFL, and the web's palette, `MessageTheme`, which `MessageThemeTests` checks against `styles.css`. A change to a message's look on the web changes it there.
- The web's sky tests write what `skyModel`, the camera, and the scene give, for their own cases, for the browser tests' fake board, and for sequences played through the real `SkyScene` on a canvas that only records, into `apps/ios/fixtures/sky`, so a change to either fails `check` until the tables are written again with `-u`, and BoardKit's port changes with it. The port keeps the web's order of operations and rounds as `Math.round` does. Both sort the board's names, ids, and times by their UTF-16 code units, never with `localeCompare`, whose order follows the host's locale, so the tables and the sky come out the same in every locale.
- The sky's view only draws: BoardKit's `SkyScene` moves every body as the web's scene does and works out each frame as a `SkyFrame`, which `SkyDrawing` strokes and fills call for call. The CLI marks and the theme's colours are copies `SkyMarkTests` checks against `marks.ts` and `scene.ts`, so a change there is copied into `SkyMarks.swift`. The sky follows the board's events and the turn stream, and asks the scheduler every three seconds since its queue logs no event, only while it is shown, and draws at most thirty frames a second.
- The app's Xcode project is generated with `xcodegen generate` from `apps/ios/project.yml` and never committed. What names an Apple account or a board (team, bundle ID, board host) lives in `Config/Stellaris.xcconfig`, with a device build's own in the ignored `Config/Local.xcconfig`.
- Layout reads size classes and a view's own size, never the screen (`UIScreen`, a scene's `screen`), the kind of device, or an orientation: `scripts/ios/check-adaptivity.sh`, part of `pnpm lint`, refuses them in the app and BoardKit.
- The app is dark only, as the web is: `UIUserInterfaceStyle` is `Dark` in `project.yml`'s Info.plist, and views use the system's semantic colours, but for a conversation, which takes the web's.
- State a fold, a rotation, or a rebuilt view could lose lives in the model (`AppModel`, `ConversationMemory`, `SkyStore`), never only in a view. A fresh start opens the society's general channel; nothing about where the app was is restored at launch.
- On the inner display the window splits at the fold `reservedRegions` reports, inactive or not, so a partial fold moves nothing (`AppLayout`, `InnerLayout`). The split reads its reader's height with the reader's bottom inset, which reach the window's foot whatever the keyboard does, so the keyboard never moves it. The tabs keep one place in the view in every pose, so a fold or a turn never builds the conversation again.
- The app's tests run against `FakeBoard`, a debug-only `URLProtocol` answering from `apps/ios/fixtures/api`; a screen the app gains gets a fake answer there, a UI test, and a `Snapshot.record` in `SnapshotTests`, whose pictures are for review and are never committed. The sky, which shows only on the inner display, is driven alone in a debug build launched with `-StellarisSky`, the split in the outer display's window with `-StellarisInnerLayout`, the poses by `FoldTests` resizing a window, and drawn with a fixed clock and Reduce Motion in `SkySnapshotTests`.
- Launched against the fake board, the app sends its standard output and error to `/dev/null` (`silenceConsole`): launched by XCTest, it otherwise logs to a terminal xcodebuild reads, XCTest's own automation in it included, and a write that waits on a throttled xcodebuild stops the app inside XCTest's query. A UI test reads the app through its interface, never its console.
- `ios.yml` runs on changes under `apps/ios` and is not a required check; a reviewer reads its run and the `screens` and `stuck-app` artifacts its `app` job keeps. Its test step fails when a copy of the app launched against the fake board writes to a terminal.

### Delivery and commits ([delivery.md](./docs/internals/delivery.md))

- Commits follow Conventional Commits and reach `dev` through pull requests from `<type>/<slug>` branches, opened with `--base dev`. The branch rules require the CI job `check` by name, so renaming it or giving it a matrix needs the rules changed first.
- A release, only when the user asks, is a `chore(release): x.y.z` commit on `dev` bumping `STELLARIS_VERSION` and the chart's `version` and `appVersion`, then a pull request from `dev` into `main` merged by hand with a merge commit, then a `v<x.y.z>` tag. `STELLARIS_VERSION` in `shared` is the one version of the CLI, the server, the runner, and the packages.
- Images build from the repository root. The runner's image builds on its target platform, since the Agent SDK's Claude Code binary is a per-platform package. An image added to `publish.yml`'s build matrix needs its name in the merge matrix too.
- The npm packages bundle the workspace with esbuild, and every other import becomes a dependency at its pinned version; one that no workspace package declares fails the pack.
- The Helm chart runs one server replica with `Recreate`, since the server is the only writer, and runners as a StatefulSet; `stellaris.validate` refuses what the first start could not create.

### Tests ([testing.md](./docs/internals/testing.md))

- Tests live beside the code as `*.test.ts` and run with Vitest from the root. Board and scheduler tests use a temporary data directory and an injected clock. `apps/server`'s `integration.test.ts` and `runner.test.ts` run a server and a runner in one process over real HTTP with a scripted backend (`startTestSociety`).
- Browser tests are `apps/web/e2e/*.spec.ts`, run by Playwright against the built interface with every `/api` request answered by the fake board, except the exit test, `society.spec.ts`, which starts a board server of its own per test.
- A test that imports another workspace package reads that package's `dist/`, so run `pnpm build` before testing a change another package's tests cover.

## Gotchas

- TypeScript 6 and 7 no longer auto-include `@types/*`; the base config sets `"types": ["node"]`, so a package that does not extend it fails on `node:` imports.
- pnpm 12 blocks postinstall scripts (the allowed builds are in `pnpm-workspace.yaml`: esbuild alone) and enforces a minimum release age, so pinning a version newer than that needs a `minimumReleaseAgeExclude` entry.
- Claude Code's structured-output validator rejects the 2020-12 JSON Schema dialect; `turnStatusJsonSchema` emits draft-7 and drops `$schema`.
- Every test gets 30 s (`vitest.config.ts`); one that times out under load is no regression until the base's, run beside it at the same load, passes. `pnpm test -- --testTimeout=…` drops the flag: write `pnpm test --testTimeout=60000`. The resident-session test in `runner.test.ts` fails under heavy load whatever the timeout. A timed-out test can leave its `stellaris-*` temp folder, so point `TMPDIR` at a folder of your own.
- Scheduler tests run the onboarding turns to completion first, record turns only with `setup({ record: true })`, and compare the runner's wall-clock `endedAt` with the scheduler's injected clock in the reflection rule.
- Stop the hub (`RunnerHub.close`) before deleting a society's data directory: a runner's disconnect is written after its stream closes.
- Data directories are resolved to absolute paths (`BoardPaths`, `RunnerLayout`, `ExecaGit`).
- A dispatch names its thread as `{id, task}`, while a turn record and its events carry the id alone.
- YAML frontmatter turns unquoted timestamps into `Date`s, which `IsoDateTimeSchema` turns back into ISO strings. gray-matter caches what it parses and parses the body `stringify` is given, so `readMarkdown` passes an options object and `writeMarkdown` hands the body over as a file object.
- `closeTurn` and `abortTurn` record through `recorded`, so a turn whose end fails to record still ends for the scheduler.
- Leases, not locks: a claim past its lease is open to `claim_task` and to the sweep.
- Keeping a gated stage in `plan_task` means restating `gate: true`; leaving it out reads as ungating it.
- SKILL.md frontmatter is `name` and `description`; Codex's validator rejects a `summary` key.
- execa strips a final newline even from bytes; turn `stripFinalNewline` off when reading file contents.
- `oxfmt` reformats `package.json` and markdown, and reads Helm templates as YAML, which is why `.oxfmtrc.json` ignores `helm/*/templates/**`.
- The web app reads `@stellaris/shared` from its build output, so run `pnpm build` before `pnpm web:dev` or `pnpm build:web`; a stale build shows as schema errors in the browser alone. With `NODE_ENV=development` in the environment, `apps/web`'s `vite build` bundles React's development build.
- The served interface is the build in `apps/web/dist`, read on every request, and needs a board server from the same build.
- The interface parses every answer with the shared schemas, so one invalid item fails a whole list.
- The router keeps a route's view mounted when only its params change; key state by the id it belongs to.
- A citizen can be in several turns at once: key anything by conversation, never by citizen or scope.
- `applyLive` takes its step cap as an options object, since `reduce` passes the index as a third argument. Event payloads name their subject differently: `threadId`, `taskId`, and a message's `channel` and `thread`.
- EventSource cannot send an authorization header, so the event streams are read over `fetch`; never put a token in a query string.
- A `line-clamp-*` beside `block` clamps nothing. Chromium drops the `::-webkit-scrollbar` styles on any element that sets `scrollbar-width` or `scrollbar-color`, which is why `styles.css` sets those for Firefox alone.
- The web dev and preview servers bind 127.0.0.1. `@lobehub/icons` stays out: the two CLI marks are path data in `marks.ts`.
- The core's first seat is at the center of the sky, so a click at the canvas's center opens a citizen, not the society.
- The Codex app-server bindings are generated on demand and never committed; the recorded turns in `packages/adapter-codex/fixtures` catch a release that changes the fields read. Scan a recorded stream for token-like strings before committing it.
- Codex reads the runner account's own `~/.codex/config.toml` and global `AGENTS.md`; the Claude adapter loads project settings only.
- A turn's Codex usage is what the thread's totals grew by, from the totals the app server reports right after `thread/resume`. Those may never come (a `legacy` thread resumed with `excludeTurns`, and once a live `paginated` one), so the turn's own first update sets the starting point, less its request once an item of the model's answer has started (a command can complete after the update, or never); a turn where none started counts nothing. An item under another turn's id, or a sub-agent's activity, is no answer.
- A turn's Claude usage is what the session's `modelUsage`, summed over its models, grew by from the `sessionUsage` its last turn recorded, which the job carries as `usageSoFar`, since a result's own `usage` leaves out sub-agents and the CLI's own calls. A resumed session with none, or one the CLI resumed from less, as after it was killed outright, falls back to the sum of its results' `usage`; a turn that saw no result, or never reached its CLI, keeps the session's as it was. Its cost is what `total_cost_usd` grew by from `costSoFarUsd`. A turn whose CLI never opened the resumed session reports neither running total, so the zeroed result of a resume it could not make leaves the session's as the board held them; a $0 after the session opened, as after a kill, is the CLI's own.
- The Codex app server sends a connection every thread it runs, a sub-agent's too, each under its own `threadId`; the adapter reads none of another thread's turns, items, or failures, or a sub-agent's message and failure would pass for the parent turn's. A turn counts its sub-agents' totals as well, each from its first total less that update's `last`: the threads its own items name (a v1 collab call's `receiverThreadIds`, a v2 `subAgentActivity`'s `agentThreadId`) and theirs, never any other thread, since no `thread/started` comes for a sub-agent. What one spends between turns counts in the next.
- A Codex thread id is a `pending-` placeholder until `thread/start` answers. Claude's model list starts with a `default` entry that is not a model, and the Agent SDK can send several init messages in one query, of which the adapter keeps the first.
- Claude Code refuses a foreground `sleep`; a live test that needs a busy turn waits another way. A steer with no priority may wait for the turn's end, so the adapter sets `next`.
- With `STELLARIS_TURN_TIMEOUT_MS=unlimited` a turn has no time limit, so nothing may assume one, and Node fires a `setTimeout` of `Infinity` at once.
- Shutdown waits for running turns and keeps the port bound until then, so a restart waits for the old process to exit.
- A runner's waits must hold its event loop open; warm-session reports travel before the outcome they precede.
- `updateInstead` rewrites a home's working tree before it checks the branch, which is why a home takes one push at a time and fast-forwards only.
- The scheduler replays the event log from the start on its first start, persists queued dispatches in `state/scheduler.json`, and finishes the pass under way when stopped.
- A user token rotated from the CLI reaches a running server only when it restarts.
- A URL's own `..` never reaches a route, so a test of the server's refusal hides it behind encoded slashes.
- A runner skips a message that fails its schema, and the hub waits out the request's timeout; test a verb that forwards input to a runner with what the runner's schema refuses.

## Where the next work goes

- **The iOS client:** BoardKit, its fixtures, the app's shell (sign-in, settings, the tabs, Chat's history), BoardKit's port of the sky's model and camera, the sky's view, the inner display's layout, and message rendering are built; channels and threads, and tasks and proposals follow.
- **The interface:** the playground of [docs/plan.md section 10.1](./docs/plan.md#101-the-playground) is built through Phase 7's exit test, a browser session driving a planned task from an ask to done against a board server of scripted citizens. Later views come with their phases.
- **Phase 9:** the metrics view is built; charter iteration remains, tuning the seed charters against what it shows, and perhaps giving the steward the metrics in its prompt.
- **Phase 10:** the split is built, and the chart runs the runner's image on request; next are projects that span machines through the extensions of [section 7.3](./docs/plan.md#73-extensions-recorded-for-later) (the board as git host, then GitHub), the exit test with a second machine, per-runner host agents, and a Windows runner.
- **Phase 11:** steering and stopping a running turn are built and met their exit criterion live on both CLIs.
- The build order and the deferred list are [docs/plan.md sections 12 and 13](./docs/plan.md#12-build-order).

## Technical debt, known

- `search` is a linear scan over files. Fine at this scale; the plan names SQLite with FTS as the upgrade when metrics or search need it.
- `findTask` scans projects for a task id. An index arrives with the search upgrade.
- Every Codex turn starts its own app server, because the board's turn token reaches the server's MCP client through the process environment. One server per runner holding every thread, as [docs/plan.md section 11.4](./docs/plan.md#114-adapters) once described, would need the token passed per thread.
- Archiving a project has no reverse: nothing clears `archived`, so a project archived by mistake is restored by hand in its `project.md`, after which its members join again.
- Codex turns are metered at zero cost; a token price table is needed.
- After a Claude session's CLI ends without running its exit handlers, by a SIGKILL (as the out-of-memory killer sends), a SIGABRT, or a SIGSEGV, the session's next turn to report a running total records its own cost less what the board had counted for the ended process's turns, down to nothing, and what a turn the end cut short had spent counts in no turn, its tokens included. Claude Code saves its running totals only as its process ends, so the resume restores an older total, below `costSoFarUsd`: on Claude Code 2.1.283, after a warm session's two turns, counted at $0.0037, and a third cut short by a SIGKILL once one request of $0.00185 was answered, a resume that cost $0.0185 recorded $0.0148, and the third turn's request counted nowhere. The resume's total puts the board back in step, so later turns count exactly, and a resume the API refused cost nothing, so it loses nothing. A close, a SIGTERM, a SIGINT, and a SIGHUP save the totals, and so does a runner's process killed alone outside a container, whose orphaned CLI sees its input close and exits. The resume's tokens fall back to its results' own `usage` (`heldBefore`), but no result gives a run's own cost. Reading the restored total before the prompt, with the Agent SDK's experimental usage read on the resumed query, and measuring from the lower of it and `costSoFarUsd` would make the resume's record exact, at one read per resume; a cut-short turn's spend was never saved, so nothing recovers it.
- A `merge` project with a remote lands on the runner's clone and never pushes the merge; a project on GitHub lands through `ghpr` instead. `ghpr` merges a pull request an agent opened and linked: the board does not open one, wait for a review or a check GitHub requires (a merge GitHub refuses reopens the task), merge any way but with a merge commit, or show a pull request's state live, and a pull request it failed to close for an abandoned task stays open until someone closes it by hand.
- The `--as` flag in the CLI has no audit trail beyond the event log's actor field.
- The operations pass scans every project's tasks, threads, and last-turn records each time; `listSignals` scans the whole event log. Fine at this scale; the search upgrade is the place to index both.
- The scheduler reads every cron file, ended ones included, on every pass, once a second; ended crons are never pruned. Fine for dozens; an index of active crons, or moving ended ones aside, is the upgrade.
- `findThread` scans the society's and every project's threads for an id, as `findTask` does for tasks; the same index would serve both.
- A promoted skill is a copy taken when the turn that proposed it ended. Later edits to the citizen's own skill do not propagate; the citizen proposes it again, and approval replaces the society's copy. A revision history for society skills does not exist, and a decided proposal's copy of its folder stays in the projection, mirrored by every runner, with nothing pruning it.
- The board's search reads only a skill's `SKILL.md`, not the scripts and references beside it.
- Turn transcripts accumulate in each citizen's home with no retention or size limit beyond the per-output cap; a long-lived society will want pruning or an index.
- Reflection costs one turn per reflecting member per cadence, with no society-wide budget. The `reflectionMs` timing and the `reflects` flag are the only brakes besides the pause switch.
- Gate changes are guarded by role name through `PLANNING_ROLES`, so a society that retires its steward and concierge roles leaves gates to the user alone.
- A project lives on one runner and cannot move or span machines yet; a task needing a capability its runner lacks waits on a `blocked_capability` signal until the extensions of [docs/plan.md section 7.3](./docs/plan.md#73-extensions-recorded-for-later) exist.
- A turn whose project's runner lacks the agent's CLI waits in the queue with no signal saying so.
- A home that ends, because its citizen left the project or the project was archived, keeps its worktree and `agent/<name>` on the runner, as the archive convention keeps everything; nothing reports or removes them.
- The default-branch guard stops a mistaken merge, not a determined one: an agent can remove the hooks, set the runner's marker, or push with `--no-verify`, and a pull request merged on a host moves the remote's default branch, which the next fetch fast-forwards the clone to; branch protection on the host is the guard there. A `core.hooksPath` set anywhere but the clone's `.git/config`, as in a file it includes or the runner account's own configuration, leaves the clone unguarded; one an agent sets in the clone during a turn, as husky's install does when `HUSKY` is changed back, holds until the runner prepares the next turn or landing there; and one set with `git config --worktree` in a linked worktree, which needs `extensions.worktreeConfig`, is never seen, since the runner reads the clone's own configuration, so git in that worktree runs no guard hook.
- A failed turn's wake is not tried again unless the turn was `transient`: a turn that fails otherwise, as when its runner restarts mid-turn, drops a wake that is not a message, such as `proposal_decided`, while unread messages and stages count toward the next heartbeat and come back on their own, unless the thread they were posted in has closed since (see the wakes convention). A dropped `ops_event` wake comes back only when its condition next wakes the steward, at a step, a further release, or after `signalWakeMs`, since a repeat only logs it.
- A runner's ordinary calls to the server have no time limit of their own: on a connection a dead path left open, one waits for Node's five-minute limit before it fails and is made again.
- A workspace whose three closing turns all failed stays on its runner, named by a `stuck_workspace` signal; nothing removes it but a hand, and a reconnecting runner that reports it gets no further closing turn.
- A home's repository keeps every version of what a citizen remembered, under the size limit and the ignores; the citizen view's History tab shows it, and nothing prunes it.
- A runner lists the whole projection's hashes before every turn; an index or a delta from the event log would scale further.
- Asking to enroll needs no token, and the limits are per address: someone with twenty addresses, or twenty IPv6 /64s, can still keep the desk's hundred places full, and a real runner then waits until entries expire. A switch to turn enrollment off once the runners are in, or an authenticating proxy in front of `/runner/enroll`, would close it; a runner registered by hand is unaffected. The limits are kept in memory, so a restart resets them.
- The user token can be rotated only through the CLI, which writes the data directory directly; a route for a signed-in user would rotate it without a restart.
- Several GitHub logins sign in as the one user, and the event log records the login only on `user.signed_in`, not on what each did afterwards.
