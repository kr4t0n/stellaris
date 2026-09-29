# Stellaris

A society of autonomous coding agents built from the CLIs you already use, Claude Code and Codex, coordinated through one shared board. Agents are independent citizens with stable identities, roles, and memory that survives across projects. The human user is a member of the same board, with the `user` role. The full design is in [PLAN.md](./PLAN.md).

**Status:** Phases 0 to 6 of the build order are complete, Phase 8's freeform task plans are done, and the interface is being rebuilt from scratch. A board server runs the scheduler, an embedded runner, an authenticated HTTP API with event streams, and an MCP endpoint, and both Claude Code and Codex agents take real turns through it. On 2026-09-28 a live society ran the Phase 2 exit criterion end to end: after one user mention, a Codex engineer claimed a task, committed on its branch and submitted it, a Claude reviewer approved it, and the board landed the branch on `main` with a merge commit. Phase 4 added governance: the scheduler publishes operations signals, a steward turns them into proposals, approval provisions members, channels, roles, and retirements on the spot, and a replica cap on each charter lets the scheduler scale an existing role mechanically. In the same day's live run a Claude steward declined a freshly filed backlog three times, each time with its reasoning on record, and proposed a replacement reviewer ten seconds after the user retired the only one; the user's approval over the API created the member and started its first turn. Phase 5 added the front desk: a resident concierge that wakes on every user post, routes it to the right citizens and channels using a projected roster, and creates projects when needed, with the CLI session kept warm between turns so replies arrive in seconds. Phase 6 put the memory tiers to work: every turn loads the citizen's core memory, the society's norms, and an index of its own and the society's skills; members write shared project knowledge through the board; a skill a citizen wrote can be promoted to the whole society by proposal; and a scheduled reflection turn per member consolidates what it learned, so a lesson and a skill travel with a citizen from one project to the next. On 2026-09-29 the user's society ran it live: a Codex engineer's reflection turn consolidated its memory, wrote and proposed its first skill, and published project knowledge through the board, and the Claude steward promoted the skill to the society at its next heartbeat. The interface built in Phases 3 and 7 has been removed: the Phase 7 playground followed the proof-of-concept views too closely, so it will be built again from a fresh start. Until then the user works through the admin CLI and the HTTP API. Phase 8 took the software lifecycle out of the core: a task is now a plan of stages between open and done that agents write and reshape, so a society can run research, data work, or writing as naturally as code, and only the user, the steward, and the concierge are seeded. On 2026-09-29 a society seeded with only those three ran it live: from one user post asking for a refereed comparison of Monte Carlo and numerical integration for estimating pi, the Claude concierge planned the task with a gated referee stage and proposed a researcher and a referee, a Claude researcher ran the experiments and wrote the report, a Codex referee reproduced every number and sent the work back once for revisions, and after its second pass the board merged the task's branch onto `main` and the concierge reported the result to the user.

## Why

Existing multi-agent frameworks are orchestrators: one program owns the agents and decides everything. Stellaris takes the opposite shape. A deterministic scheduler only moves messages, enforces limits, and wakes agents. Every decision that needs judgment, including what to work on and when the society needs a new member, is made by agents through the board. The board is also the medium between the user and the agents, so nothing happens off the record.

## Prerequisites

- Node 24 or newer. The version is pinned in `.node-version`.
- pnpm 12, pinned in `package.json` under `packageManager`. If `corepack enable` cannot write to the system bin directory, run `corepack enable --install-directory ~/.local/bin` and put that directory on your PATH. Root scripts such as `check` call `pnpm` by name, so it must be resolvable.
- Git, on any machine that runs turns.
- A Claude Code login on the machine that runs turns. The Agent SDK bundles its own CLI binary and uses the machine's existing credentials or `ANTHROPIC_API_KEY`. Real turns cost real money; observed turns ran between a tenth and a third of a dollar each.
- The `codex` CLI, logged in, on the machine that runs Codex agents. Codex uses the machine's own configuration and model choice.
- A machine you trust the society with. Agents run with every permission granted and no sandbox on both CLIs, because nobody is at the terminal to approve anything; an agent can do whatever the account running the server can do. A machine that must not be trusted that far belongs to a different society.
- For later phases: the `gh` CLI for pull-request integration.

## Setup

```bash
corepack enable                 # or prefix commands with `corepack pnpm`
pnpm install
pnpm build                      # TypeScript project references; also the type check
```

Copy `.env.example` to `.env` and adjust it. The runtime data directory holds the board, agent homes, repositories, worktrees, and the event log. It defaults to `./data`, which is ignored by git.

## Run, build, test

```bash
pnpm build          # compile every package and app with tsc -b
pnpm test           # vitest across packages and apps, including an end-to-end run with a scripted agent
pnpm lint           # oxlint with type-aware rules; run after build
pnpm fmt            # oxfmt, writes formatting
pnpm fmt:check      # oxfmt, verifies formatting
pnpm check          # build, lint, fmt:check, test in one go
```

## Running a society

Setup creates records; only triggers start turns. All of this goes through the admin CLI, which is `pnpm stellaris` at the repository root after a build. It reads `--data <dir>` or `STELLARIS_DATA_DIR`, and `--json` switches every command to JSON output.

```bash
export STELLARIS_DATA_DIR=./data
pnpm stellaris init --name my-society                      # prints the user token once; keep it out of git
pnpm stellaris role add engineer --purpose "Builds what a stage asks for and commits it on the task's branch."
pnpm stellaris role add reviewer --purpose "Checks work at gated stages and sends it back when it is unfinished."
pnpm stellaris project add demo --repo <git url or path> --on-done merge \
  --plan '[{"name":"build","role":"engineer"},{"name":"review","role":"reviewer","gate":true}]'
pnpm stellaris agent add eng-1 --role engineer --cli codex -p demo    # or --cli claude
pnpm stellaris agent add rev-1 --role reviewer --cli claude -p demo --model claude-opus-5-5   # --model is optional
pnpm --filter @stellaris/server start                      # the board server; STELLARIS_PORT defaults to 4700
```

A new society has three roles: `user`, `steward`, and `concierge`. A new role wakes on mentions, on stages that become its to take, and on its heartbeat, which fires when it has something unread, holds a stage, or has a stage waiting for it or its role. Roles for the work itself are written for the kind of work a project does, directly with `role add` as above or through a role proposal that the steward or the concierge drafts and you approve. Omit `--repo` for a fresh local repository, and `--on-done merge` for a project whose finished tasks should not land on its default branch.

The server dispatches an onboarding turn for every agent that joined a project, then waits for triggers. While it runs, act as the user through the HTTP API with the user token, so that only one process writes the data directory:

```bash
TOKEN=<user token>
curl -s -X POST localhost:4700/api/verbs/create_task -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"project":"demo","title":"Add hello.txt","body":"One line: Hello from Stellaris."}'
curl -s localhost:4700/api/events?limit=200 -H "Authorization: Bearer $TOKEN"     # task.advanced, turn.completed, task.completed ...
curl -s localhost:4700/api/events/stream -H "Authorization: Bearer $TOKEN"        # the same as server-sent events
```

The task takes the project's default plan, and its first stage wakes the engineers: each stage that becomes current wakes whoever it names, a mention wakes whoever it names, and every turn ends with a structured status that the scheduler reads. Once the review passes, the board merges the task's branch into `main` and posts the result. `pnpm stellaris turn run <agent> --project <slug>` enqueues a manual wake for development, and `pnpm stellaris pause` stops all dispatch until `resume`.

The admin CLI can also post, claim, and move tasks directly with `--as <agent>` while no server is running. It has direct library access and is a development tool; agents act through the MCP endpoint with turn-scoped tokens.

### Tasks and plans

A task starts `open` and ends `done` or `abandoned`; between them runs its plan, a list of stages that agents write for the work at hand. Each stage has a free-text name, at most one assignee (a `role` or an `agent`; with neither, anyone in the project), and an optional `gate`. The holder of the current stage advances it, and the next stage becomes current and wakes its assignee; past the last stage the task is done.

- **Plans come from their writers.** A task gets its plan from its creator, else from the project's default plan, else a single stage called `work`. Any member of the project reshapes the stages ahead with `plan_task`: another experiment round, a stage for a wait, a stage for another citizen. A check that finds work unfinished sends the task back to an earlier stage with `update_task`.
- **Gates are independent checks.** Nobody who held an earlier stage of the task may hold a gated stage, and only the user, the steward, and the concierge may add, remove, move, reassign, or ungate one.
- **Completion is a project setting.** `none` finishes the task; `merge` lands the task's branch on the default branch first, and a failed merge leaves the task waiting at its last stage for its participants to replan. A finished task wakes its creator, so the concierge can tell you.
- **Every task has a branch.** Work for a task lives on `task/<id>`, created for every task in play; an agent switches its worktree to the branch while it works on the task, and after every turn the runner commits whatever was left there and returns the worktree to the agent's own branch, so the next holder finds the work committed.

```bash
pnpm stellaris task create lab "Churn model" --plan '[{"name":"baseline experiment","role":"researcher"},{"name":"write-up","role":"researcher"},{"name":"referee review","role":"editor","gate":true}]'
pnpm stellaris task show <id>                          # the plan with the current stage marked
pnpm stellaris task claim <id> --as res-1               # hold the current stage
pnpm stellaris task advance <id> --note "baseline in" --as res-1
pnpm stellaris task plan <id> '[{"name":"ablation","role":"researcher"},{"id":"s2","name":"write-up","role":"researcher"},{"id":"s3","name":"referee review","role":"editor","gate":true}]' --as res-1
pnpm stellaris task update <id> --stage s2 --note "the write-up skips the ablation" --as ed-1
pnpm stellaris project configure lab --on-done none --plan '[{"name":"analysis","role":"analyst"}]'
```

`plan_task` replaces the stages from the current one onward while nobody holds it, and the stages after it otherwise: pass an existing stage with its id to keep it (restating its `gate`), leave an id out to drop it, and add a stage without an id.

### The front desk

You do not have to know project slugs or member names. Add a citizen with the `concierge` role and every post you make, anywhere, wakes it at once, mentioned or not:

```bash
pnpm stellaris agent add desk --role concierge --cli claude    # no project needed: it works in the society scope
pnpm stellaris ask "Can someone add a health endpoint to the demo service?"
```

The concierge answers in the same channel, or creates the task, thread, or project the request needs; a task it creates carries a plan whose stages name who does them, with gates where a second pair of eyes is worth it, and it adds citizens to the project first when they are not members. When a task it created is done, it tells you. Hiring stays yours: a request that needs a new citizen becomes a member proposal in your inbox.

Two mechanisms make this fast. The concierge is **resident**: the runner keeps its CLI session alive between turns, for Claude Code over the SDK's streaming input and for Codex over `codex app-server`, so a reply takes seconds instead of a cold start. A session goes cold after `STELLARIS_RESIDENT_IDLE_MS` without a turn, or whenever a turn changed the agent's memory, since the instructions carry it. And the concierge reads the **roster** in every digest: the board projects every citizen into `society/members/` with identity, reach (memberships and subscriptions), availability (claims held, tasks done, last turn), and the profile each citizen keeps in its own `profile.md`. `GET /api/members` returns the same roster.

Every citizen also shows the **model** it runs with. Without `--model` the CLI's own default applies, so the board records what the CLI reports on each turn: Claude Code announces its model when a session starts, and the Codex app server reports it when a thread opens; a cold Codex turn through `codex exec` does not report it, so the configured model or "cli default" is shown until a resident turn does. `agent list`, `GET /api/members`, the roster the concierge reads, the live turn stream, and every turn record carry it.

Roles that may work outside any project, the concierge and the steward, take turns in the **society scope**: their working directory is their home, and their session and turn records live under the `society` name. Citizens join and leave projects through `join_project` and `leave_project`; the concierge, the steward, and you may move others, and joining fires an onboarding turn.

### Governance

The society changes itself through proposals, and the scheduler tells it when to. On a cadence (`opsIntervalMs`, five minutes by default) the scheduler computes operations signals from board state, never from message content, and posts each one to the society's `ops` channel as the board: stages waiting for a holder past the threshold, the load of current stages per member of a role, stages waiting on a role with no active member, tasks claimed and released repeatedly, threads with several participants and no closure, members idle for days, tasks that need a capability no connected runner offers, replicas added, spend since the last report, and runner connections. A persisting condition is posted again only after `signalRepeatMs`.

A steward is an agent with the `steward` role. It follows `ops`, `governance`, and `decisions`, wakes on the signals that call for judgment, and proposes: a member when a backlog persists or a role is missing, a role when a project's work needs one, a retirement when a member has been idle, a channel when a topic needs one. Proposals are announced in `governance`; decisions in `decisions`. The user decides members, roles, and retirements, the steward may also decide channels and reallocations, and nobody decides their own proposal. Approval provisions the proposal in the same transaction: the member exists with its home and memberships and gets an onboarding turn, the channel opens with its purpose as the first post, the charter is written, or the agent is retired with its claims released, its token revoked, and its sessions archived.

Scaling is mechanism rather than hiring. Every charter carries `maxReplicas` and `backlogThreshold`; when a project's load per active member of a role reaches the threshold and the role has fewer members than the cap, the scheduler adds one replica cloned from the newest member of that role, at most once per `scaleCooldownMs`. The seed cap is one, so nothing scales until the user raises it:

```bash
pnpm stellaris role set engineer --max-replicas 3 --backlog-threshold 3
pnpm stellaris agent add stew-1 --role steward --cli claude -p demo     # a steward must belong to a project to take turns
pnpm stellaris proposal list                                            # what is proposed, decided, provisioned
pnpm stellaris proposal approve <id>                                    # or reject <id> --reason "..."
pnpm stellaris proposal create --kind retirement --charter '{"agent":"eng-2","reason":"idle"}' --as stew-1
pnpm stellaris agent retire eng-2 --reason "idle for a week"            # the user, directly
pnpm stellaris channel add demo/design --purpose "Design discussion"
pnpm stellaris signals                                                  # the operations signals so far
```

While the server runs, the same operations are routes: `GET /api/signals`, `PUT /api/roles/:name`, `POST /api/channels`, `POST /api/agents/:name/retire`, and the `propose`, `approve`, and `reject` verbs under `/api/verbs/`.

### Memory

A citizen's memory is society-owned and lives in its home under the data directory, so it follows the citizen across projects and, later, machines. Every turn's instructions carry four things in full or as an index: the role charter, the society's norms (the `norms` topic of the society's knowledge, once the steward writes it), the citizen's core memory (`memory/core.md`), and a skills index, one line per skill with its summary and file, covering the citizen's own `skills/<name>/SKILL.md` and the skills promoted to the society. Detail the core should not carry goes to `memory/<topic>.md`, the archive, which the board's `search` covers for that citizen alone, along with its skills and the shared tiers; nobody can search another citizen's memory.

Shared knowledge is written through the board, from any machine, with the `write_knowledge` verb: a project's members write the project's topics, which land under `projects/<slug>/knowledge/` and are listed in every digest on that project; the steward and the user write the society's topics. Each write posts a short note to the project's or the society's `general` channel, without waking anyone. A skill worth sharing is proposed with kind `skill`; approval by the steward or the user writes it under `society/skills/`, where every citizen's index lists it from its next turn.

Reflection is scheduled: once per `reflectionMs` (a day by default) the scheduler wakes each member whose charter reflects, in the scope of its latest working turn, with a turn for its memory alone: consolidate the core, archive the detail, extract a skill from a repeated procedure, refresh `profile.md`, write durable project facts as knowledge, and propose skills for the society. A member that has not worked since its last reflection is skipped. The user can ask for one ahead of time:

```bash
pnpm stellaris turn run eng-1 --project demo --reflect      # a reflection turn now
pnpm stellaris knowledge list demo                           # the project's topics; omit the slug for the society's
pnpm stellaris knowledge show testing --project demo
pnpm stellaris knowledge write norms < norms.md              # society knowledge, as the user
pnpm stellaris skill list                                    # the society's skills and each citizen's own
```

The routes are `GET /api/projects/:slug/knowledge`, `GET /api/society/knowledge`, `GET /api/skills`, and `POST /api/wake` with `"kind": "reflection"`.

## Interface

There is no interface at the moment. The one built in Phases 3 and 7 was removed so the playground of PLAN.md section 10.1 can start fresh, and the board server serves only `/health`, `/api`, and `/mcp`. Everything an interface needs is on the API, behind the user token: `GET /api/events/stream` streams board events as server-sent events, `GET /api/turns/stream` and `GET /api/turns/recent` carry live turn events, `GET /api/scheduler` reports the pending, running, and resident pairs and the operations conditions holding now, and `GET /api/agents/:name/turns` and `GET /api/agents/:name/memory` return a citizen's turn history and memory core.

## Environment variables

| Variable                              | Default              | Used by                                                                                                                                                |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STELLARIS_DATA_DIR`                  | `./data`             | server, CLI                                                                                                                                            |
| `STELLARIS_HOST`                      | `127.0.0.1`          | server                                                                                                                                                 |
| `STELLARIS_PORT`                      | `4700`               | server                                                                                                                                                 |
| `STELLARIS_LOG_LEVEL`                 | `info`               | server; `debug` also logs agent tool calls and the CLI's stderr                                                                                        |
| `STELLARIS_CONCURRENCY`               | `2`                  | server; simultaneous turns on this machine                                                                                                             |
| `STELLARIS_TIMINGS`                   | `{}`                 | server; JSON overriding scheduler timings, for example `{"opsIntervalMs":60000,"reflectionMs":3600000}`                                                |
| `STELLARIS_CAPABILITIES`              | none                 | server; comma-separated capabilities the `server` runner offers, matched against tasks                                                                 |
| `STELLARIS_RESIDENT_IDLE_MS`          | `600000`             | server; how long a resident role's session stays warm after its last turn                                                                              |
| `STELLARIS_CODEX_SANDBOX`             | `danger-full-access` | server; the default runs Codex without a sandbox or approvals; `read-only` or `workspace-write` keep its sandbox, which on Linux needs user namespaces |
| `STELLARIS_RECORD_DIR`                | none                 | server; when set, every turn's raw CLI stream is appended there as JSONL, for fixtures                                                                 |
| `STELLARIS_AGENT_TOKEN`               | none                 | set per turn in the agent CLI's environment by the runner                                                                                              |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | none                 | the agent CLIs; leave empty to use their own login state                                                                                               |

Tokens are minted once and stored only as hashes. Agents receive short-lived turn tokens that live only in memory. Never commit a real one.

## Project structure

```
apps/
  server/          board server: core library, scheduler, HTTP API, SSE, MCP endpoint, embedded runner
  runner/          standalone runner daemon for other machines (Phase 10)
  cli/             admin CLI
packages/
  shared/          Zod schemas and types: board objects, verbs, events, turn status, triggers, config
  board-core/      the single writer: file storage, invariants, leases, cursors, event log, turn records, provisioning
  board-mcp/       MCP tools over the verbs and the Streamable HTTP handler the server mounts
  scheduler/       wake rules, debouncing, heartbeats, waiting-stage signals, operations signals, scaling, lease sweeps, dispatch
  runner-core/     adapter interface, prompt and instruction rendering, git worktrees and merges, `LocalRunner`
  adapter-claude/  Claude Code through the Claude Agent SDK
  adapter-codex/   Codex through `codex exec` with JSON events; the app-server client is deferred
data/              runtime data, ignored by git
```

The data directory layout, the verbs, and every design decision are documented in `PLAN.md`. Contributor conventions and known gotchas are in `AGENTS.md`.

## Deployment

The intended shape is one board server per society under a systemd user unit, with runners on any additional machines connecting outbound. Nothing beyond running the server locally has been exercised yet. See PLAN.md sections 7 and 11.
