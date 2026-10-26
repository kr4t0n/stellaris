# Runners and the server

The board server and the runners that run its turns: what a job carries, how runners connect, enroll, and stay connected, how people sign in, and what the server keeps about each runner's CLIs. [AGENTS.md](../../AGENTS.md) states the rules in short; this page has the detail and the incidents behind it. The protocol itself is [docs/plan.md section 7.1](../plan.md#71-the-runner-protocol); what each CLI's adapter does is on [adapters.md](adapters.md), and worktrees on [workspaces.md](workspaces.md).

## The server runs no turns

### The server runs no turns, and a project lives on one runner

A runner is a process of its own, on the server's machine as on any other, registered by enrolling, which the user approves on the board, or with `runner add` (or `POST /api/runners`), which shows its token once; the board keeps only the hash, in `state/runners.json`, outside the projection. It speaks the protocol of [docs/plan.md section 7.1](../plan.md#71-the-runner-protocol) under `/runner`: it registers, holds one server-sent event stream for jobs, landing requests, model-list requests, and the steers and stops of its turns, and posts everything back.

A project is placed on the runner that takes its first turn (`placeProject`, once, `project.placed`), which holds its repository and every worktree, and every later turn of the project goes there; a citizen's society-scope turns go to the runner it is pinned to, its `homeRunner` (`pinAgent`, set on its first such turn to the least busy runner that can take it, `agent.placed`), which they wait for while it is busy or away for less than the grace period and which moves, pinned anew, once it has been gone longer or lacks the citizen's CLI; the user sets or clears it with `setAgentRunner` (`PUT /api/agents/:name/runner`, the citizen view's Runner…, `agent runner` in the CLI). A turn no runner can take now stays queued: `TurnRunner.assign` returns null and the scheduler keeps the dispatch. Landing is a request to the project's runner, `deferred` while it is away.

#### A stream can look open and deliver nothing, so both ends check

The server writes a comment every 15 seconds, and the runner's client takes a stream that has carried nothing for `STREAM_IDLE_MS` (45 seconds) for dead and connects again, where Node's fetch alone would wait five minutes. A runner acknowledges each job as it arrives (`POST /runner/turns/:id/received`, `RunnerHub.received`); the hub keeps every job sent and not yet acknowledged on its seat (`unacked`), and one unacknowledged past `ackTimeoutMs` (30 seconds) marks the seat `unconfirmed`, so no more turns are placed there until it acknowledges a job or attaches a new stream, while its turns in flight carry on, since they report by posts; the hub does not close the stream for it, which would start the grace period and fail turns running fine behind a network that comes back. When the runner registers again, a turn it lists carries on, one whose job it never acknowledged is sent again down its new stream, and only one it took and no longer runs fails as restarted; a runner that stays away past the grace period fails its unacknowledged turns as never having reached it. A turn's steps and outcome are posted again, in order, while the failure is the network's or the server's (`persist` in the daemon: no answer, a 5xx, or a 429), for up to `postForMs` (fifteen minutes), and given up on a refusal; the hub answers steps and an outcome for a turn it no longer has with success, so nothing retries those. Every warning the runner logs about the server names the error's causes (`describeError`), since Node's fetch reports every network failure as `fetch failed` or `terminated` and keeps the reason under `cause`.

A session record names the runner it began on, and a turn placed elsewhere starts a fresh session. Adapters stamp the runner's own name, which the server gave it at registration, on `turn_started`. The three protocol decisions that keep the board-as-hub and GitHub extensions additive (the job names where the code is, the outcome reports the branch and commit it left, landing is one interface) are in [docs/plan.md section 7.3](../plan.md#73-extensions-recorded-for-later); keep them.

### A job is self-contained and the board never sees a path

`TurnHost.openTurn` decides every policy, the prompt, the limits, the token, residency, and writes places in the instructions and prompt as `PATH_TOKENS` (the agent's home, the board mirror, the worktree), which the runner fills with its own paths, and the place for the workspace's state as `WORKSPACE_TOKEN`, which the runner fills once it has prepared the workspace, and the board's MCP address as `SERVER_TOKEN`, which the runner fills with the address it reaches the server by, unless `STELLARIS_PUBLIC_URL` names one for every runner. A fresh session's id comes from the runner's adapter and arrives in the outcome. Before a turn the runner pulls the board's projection (`TreeCopy`, by versions, each a file's hash marked `+x` when it is executable (`fileVersion` in `shared`), so a published skill's scripts run as they are, the server's version always winning) and brings its clone of the agent's home up to date (`HomeSync.prepare`); after it, it commits what the turn left as the agent, merges and pushes (`HomeSync.publish`), reports its warm sessions, and only then posts the outcome, so `finishTurn` refreshes the roster from the new profile and skills and the next job finds the session warm.

## Residency

### Residency is a runner mechanism

A backend that can keep a session warm implements `startResident`; a runner reports which CLIs can, and the host marks a job resident for charters marked `resident`, one warm session per home conversation (its channel, project, and thread conversations run cold). The turn token reaches a CLI once, at session start, so the host keeps a warm session's token while the runner reports the session warm, extends it with every turn, and revokes it when the runner reports the session gone; a runner given another token than its warm session started with, as after a server restart, which forgets every token, starts the session afresh, as it does when a turn reported `memoryUpdated` or did not complete, a turn the session threw on included, or the citizen's model changed. Any turn of the citizen on that runner, warm or cold, that reports `memoryUpdated` marks the citizen's warm sessions there `stale`, and each starts afresh at its next turn rather than mid-turn, since the memory its instructions carry has changed under it. A session goes cold after the job's `idleMs`. Instructions are fixed at session start, which is why memory changes recycle it. The scheduler knows nothing about residency; it dispatches turns as always.

### Warm-session reports travel before the outcome

The host reuses a warm session's token only while the runner reports the session warm. Posted on their own, a report could arrive after the outcome, the next job then carried a new token, and the runner restarted a session that was warm; `RunnerDaemon` chains its reports and waits for them before posting an outcome.

## Signing in and enrolling

### Nobody needs the user token in daily use

Two ways in replace it, and the token stays for scripts and as the way back.

#### GitHub sign-in

GitHub sign-in (`apps/server/src/github-auth.ts`, under `/auth`, on only when `STELLARIS_GITHUB_CLIENT_ID`, `_SECRET`, and `_USERS` are all set): `/auth/github` keeps a random state in memory for ten minutes and sends the browser to GitHub's authorize page with no `redirect_uri`, so GitHub uses the one callback the OAuth app registers; `/auth/github/callback` takes the state once, trades the code for a GitHub token, asks `api.github.com/user` for the login, and, for a login on the list (compared lowercased) or a numeric user id on it, which survives a rename that would free the login for someone else, calls `Board.signIn`, which mints a token, keeps its hash with the login, the account's picture (`avatar_url`, kept only as an `https` address on `avatars.githubusercontent.com`), and the expiry in `state/sign-ins.json`, appends `user.signed_in`, and resolves the token to the user actor until it expires; the browser lands on `next` (a path on the board, `safeNext`, else `/`), or, for a sign-in started with `landing=app`, at `stellaris://signin`, the address the app's `ASWebAuthenticationSession` waits for, with `#session=<token>`, or `#signin-error=` with `expired`, `declined`, `github`, or `not-allowed`.

Nothing in a request names a scheme or a host to land on: `APP_LANDING` is fixed in `github-auth.ts`, a `landing` other than `app` is no flag, `next` beside the flag names nothing, and a state the server no longer holds lands `expired` on `/`, since nothing then says the app asked. The OAuth app and its callback stay the same for the app, since the board's callback is what sends the browser on.

The fragment never reaches a server or a proxy log; `takeSignIn` in `apps/web/src/lib/signin.ts` stores the token and drops the fragment from the address and its history entry before the interface renders.

`GET /api/me` adds `signIn` (`login`, `avatarUrl`) for a sign-in token, from `Board.signInOf`, with `https://github.com/<login>.png` for a sign-in whose picture GitHub did not give on its own avatar host; the Playground provides it as `SignInContext`, and `Avatar` and `useDisplayName` in `board/Avatar.tsx` show the user's posts and name with the account's picture and login where they would say "you". It names the browser's own sign-in, not whoever wrote the post, since a message records only `user`: with several logins listed, each reader sees the user's posts as their own account, as "you" did. The user token has no `signIn`. `DELETE /api/sign-in` ends the sign-in the bearer belongs to and leaves the user token alone. The interface keeps no cookie, so there is no CSRF surface: every call carries the bearer.

#### Enrollment

Enrollment (`apps/server/src/enrollment.ts`, `packages/runner-core/src/enroll.ts`): `POST /runner/enroll` and `/runner/enroll/poll` answer before the runner-token check, and asking, like starting a GitHub sign-in, is limited per client address (`rate-limit.ts`: five asks and twenty sign-ins per ten minutes, a sliding window in memory over at most 10,000 addresses, an IPv6 address keyed by its /64, a 429 with `Retry-After`, which the runner waits out); the address is the socket's peer or, with `STELLARIS_TRUSTED_PROXIES` set, the `X-Forwarded-For` entry the outermost trusted proxy appended, counted from the right as Express's `trust proxy` counts, since everything left of it is the client's to write; at most a hundred enrollments wait at once; the `EnrollmentDesk` holds each enrollment in memory with a 256-bit device code the runner polls with and a user code `XXXX-XXXX` from an alphabet without vowels or look-alikes, matched ignoring case and separators; the user lists, approves under a name, or denies through `/api/enrollments` (the user role alone), approval calls `addRunner` with `enrolledFrom` on `runner.added`, and the token goes to the next poll once and is forgotten.

The runner saves `{serverUrl, name, token}` as `credentials.json` (mode 0600) in its data directory and reads it only for the same server; a runner started with `STELLARIS_RUNNER_TOKEN` uses that instead and never enrolls. `RunnerDaemon.start` rejects with the server's 401 when the token is refused before the first connection, rather than retrying forever; `apps/runner` then exits for a token from the environment and enrolls again for saved credentials.

#### Rotation

`stellaris user token --rotate` (`Board.rotateUserToken`) replaces the user token's hash and prints the new token once.

## Models and effort

### A citizen's model is a setting, the CLI's list is the menu

`setAgentModel` (the user only) sets or clears `model` on the agent record and appends `agent.configured`; the runner hands the record's model to every turn, and both CLIs accept a new one on resume, so it applies from the next turn without losing the session.

The choices come from the CLIs themselves through `AgentBackend.listModels`: the Claude adapter asks the SDK's `supportedModels()` on a query that is closed before it sends anything, and the Codex adapter asks `model/list` of an app server started for the question. A citizen's list comes from the runner its turns run on, since that runner's install of the CLI decides which models and levels exist: `GET /api/agents/:name/models` prefers its `homeRunner`, then the runners its projects live on, and `RunnerHub.modelRunner` takes the first connected one with the CLI, else the least busy, and answers with the runner it asked (`RunnerModelsSchema`), which `ModelForm` names. `ModelCatalog` in `apps/server` keeps each runner's list of each CLI for an hour because each ask starts a CLI, and forgets a runner's lists whenever it registers, connects, or goes away (`RunnerHub.onRunnerChange`), as `runner.*` events make the browser's copies stale.

The reasoning effort is a setting beside it: `setAgentEffort` (the user only, `PUT /api/agents/:name/effort`, `agent effort` in the CLI) sets or clears `effort`, checked only as one lowercase word (`EffortSchema`), since the levels are the CLIs' own, and appends `agent.configured` with `effort`. Each `ModelOption` carries the model's `efforts` and `defaultEffort`: the Claude adapter takes `supportedEffortLevels` (none when `supportsEffort` is false) and names `high` the default, as the SDK documents, and the Codex adapter takes `supportedReasoningEfforts` and `defaultReasoningEffort`, skipping a level it cannot name. The job carries `effort`; the Claude adapter passes it as the SDK's `effort` option when it is one of Claude Code's levels (`claudeEffort`), over the adapter's own `effort` option, and the Codex adapter as `effort` on each `turn/start`; the executor starts a warm session afresh when the effort changes, as for the model. `ModelForm` offers the chosen model's levels and drops a level the newly chosen model lacks, and writes only the settings that changed.

## Plan quota

### A CLI's quota is what its login reported, kept on its runner's record

Quota belongs to a CLI's login on a runner, not to a citizen. `CliQuota` in `shared` (`quota.ts`) holds the plan's windows, each with its key, length, `usedPercent`, `resetsAt`, and when it was last reported, the status (`allowed`, `warning`, `limited` with `limitedUntil` and `limitedBy`, or `none` for a login that reports no plan limits, such as an API key or one without the profile scope), the plan, Codex's `credits`, and Claude's `extraUsage`, and nothing else: the adapters build it field by field, so an account id, an email, or an upsell banner a CLI sends never leaves the adapter.

During a turn the Claude adapter reads `rate_limit_event`, whose `unifiedWindows` (the 5-hour and 7-day windows, not in the SDK's public type) give each window's `utilization` as a fraction of one, and the Codex adapter merges the `account/rateLimits/updated` snapshots the app server sends with a turn's requests, sparse, whose `usedPercent` is already a percentage (`mergeSnapshot`); `TurnResult.quota` carries what the turn saw, and the executor puts it on the outcome. A report outside what `CliQuotaSchema` holds, or a reset outside an ISO string's years, is dropped (`safeParse`, and a guard around each stream handler's quota step), so a CLI release that changes these shapes costs the report, never the turn: an exception in the Codex reader would have stopped it, and the turn would have run to its time limit.

Only a window every model counts limits the login: Claude's `five_hour` and `seven_day` (`LOGIN_WINDOWS`), and Codex's windows of its main bucket, `codex`; a spent scoped window (`seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, a `model:<name>` window, or a Codex bucket of another `limitId`, whose windows are keyed `<limitId>:primary` so its updates never overwrite the main bucket's) shows used up on its own meter and makes the status `warning`, since turns on other models go on, and so does a Claude refusal that extra usage covers (`overageStatus` `allowed` or `isUsingOverage`).

A turn the plan's limit refused fails, `exitReason: "error"` with `usage limit reached: <the CLI's own words>`, rather than ending as a turn without a report, so its digest is read again: Claude Code ends it with a synthetic assistant message marked `error: "rate_limit"`, Codex with an `error` whose `codexErrorInfo` is `usageLimitExceeded`, and the quota says `limited` until the reset the CLI gave.

`TurnHost.closeTurn` hands an outcome's quota to `Board.recordQuota` before the turn's end is announced, which merges it over the runner record's `quotas[cli]` with `mergeQuota` (a window keeps its last report until a newer one names it; the plan and credits keep theirs when a report leaves them out), writes the record on every report so it says when the numbers were last seen, and appends `runner.quota` only when `quotaChanged` finds a reader would see a difference (status, limit, plan, credits, a window's whole percent or reset minute), since every turn reports; a failure there is logged, never the turn's.

The user may also ask a runner to read a CLI's quota without a turn, `POST /api/runners/:name/quota/:cli`: `QuotaReads` in `apps/server` shares a read under way and answers a successful one again for a minute, since each starts a CLI process, and `RunnerHub.quota` sends a `quota` request, refused at once with a 409 to a runner whose hello lacks `quotaReads`, and records the answer. The runner's `TurnExecutor.quota` asks the backend's `readQuota`: Claude's is the SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` on a query that sends no prompt, typed from the SDK's own `Query` so a release that renames it fails the type check, whose windows' `utilization` is already a percentage; Codex's is `account/rateLimits/read` with `excludeResetCreditDetails`, on an app server that opens no thread, whose answer's `accountId` the adapter drops. Both read the CLI's usage endpoint and make no model call; Claude Code's own `quota_check`, a one-token message it sends to read rate-limit headers, is billed, and nothing here may trigger it.

The scheduler still dispatches turns of a CLI that is limited on their runner; holding them until the reset is not built.

## Running the server and runners

### Shutdown waits for running turns, and the port stays bound until then

On SIGTERM the server stops dispatching and waits for the turns in flight to be reported by their runners, which keep posting to it meanwhile; a Codex turn can hold it for minutes. A second server started on the same port before that dies with `EADDRINUSE`, while the first, whose scheduler has already stopped, keeps answering the API. Restart scripts must wait for the old process to exit, up to the turn timeout, before starting the new one. Events posted meanwhile are not lost: the new scheduler resumes from the persisted cursor. A runner on SIGTERM closes its stream first, so no job reaches it while it drains, then waits for its turns, lets its warm sessions go, and reports them; a turn whose runner never reports again ends as failed when the runner registers without it or after the hub's grace period, two minutes.

### A turn may run without a time limit, and then everything that assumed one must not

`STELLARIS_TURN_TIMEOUT_MS=unlimited` gives adapters `timeoutMs: null`: no timer is set, since Node fires a `setTimeout` of `Infinity` at once. Turn tokens then live until the turn ends, when the runner revokes them, and a running turn renews the leases of the stages it holds in its scope every ten minutes, or a thirty-minute lease would hand its stage to someone else mid-turn. Shutdown waits for running turns, so with no limit a restart waits as long as the longest turn. `STELLARIS_CONCURRENCY=unlimited` lets every ready turn run at once, each its own CLI process. `STELLARIS_TOOL_ROUNDS` bounds a Claude turn's rounds of tool calls, 60 by default; `unlimited` leaves the SDK's `maxTurns` unset, which is how the SDK means no limit.

### Two writer processes are a development-only compromise

The admin CLI writes the data directory directly. While the server runs, act as the user through the HTTP API with the user token instead, except for `turn run`, whose single appended event is harmless.

### A runner's waits must hold its process open

While the server is away and no turn runs, the timer between connection attempts is all that keeps a runner's event loop alive. The first daemon unref'd it, so the live runner exited with code 0 and no error in its first wait after a server restart, and an outcome retried across a restart could have been lost the same way; tests never saw it, because the test process always holds its loop. The waits are ref'd now, `stop()` ends the one between connections through an abort signal, and `daemon.test.ts` runs a runner as a process of its own against an unreachable server.

### A draining server may be out of reach

On SIGTERM the server waits for running turns to report, but Kubernetes takes a terminating pod out of its Service's ready endpoints, so behind an Ingress a runner may not reach the old pod to report, and a turn running across an upgrade can end as failed. The chart's README tells the user to pause, let turns end, upgrade, and resume. With `Recreate` the board is down for the whole drain, up to `server.terminationGracePeriodSeconds` (twenty minutes, the turn timeout), and a stop under way cannot be cut short: on 2026-10-12 a second `kubectl delete --grace-period=1` did not shorten a restart waiting on a Codex turn, because the kubelet (1.35) cancels the pod's sync but `SyncTerminatingPod` runs on a context of its own (kubernetes#113606), so the stop runs to the first grace period. Pausing first is what keeps that wait short.

### The old `server` runner is gone

A society no longer seeds a runner record, `SERVER_RUNNER` no longer exists, and an agent's `homeRunner` is optional. A data directory from before the split still lists a `server` runner that never connects; nothing places a project on it, since placement needs a connected runner.

### A user token rotated from the CLI reaches a running server only when it restarts

The server builds its token index from agent records at open, so while it runs it keeps taking the old token and refuses the new one. Rotating is a break-glass step, done with the server stopped or followed by a restart; in Kubernetes, `kubectl exec` into the pod, rotate, and restart the Deployment.

### An approval is handed over once

The desk forgets an approved enrollment when it tells the runner, so the token never travels twice; a runner whose poll answer was lost in transit polls an unknown enrollment, gets a 404, and asks again under a new code, which leaves a registered runner that never connects. Enrollments live in memory, so a server restart forgets the waiting ones and their runners ask again the same way.

### Behind a proxy, every request comes from the proxy

The socket's peer of a server behind an Ingress or a tunnel is the proxy, so with `STELLARIS_TRUSTED_PROXIES` left at 0 every client shares one limit, and a stranger's flood blocks your runner too; set to more proxies than there are, the server believes an entry the client wrote, and one client becomes as many addresses as it likes. The chart sets 1 when its Ingress is on, and `server.config.trustedProxies` overrides it, for example 2 with Cloudflare in front of the Ingress.

### Every route that reads a request body caps it

Neither `@hono/node-server` nor hono caps a request body, so a route that reads `c.req.json()` once parsed whatever arrived, from anyone on the two enroll routes. `limitBody` (`apps/server/src/body-limit.ts`) puts hono's `bodyLimit` in front of each such route, which answers a body over its limit with a 413 (`PAYLOAD_TOO_LARGE`) before anything parses it: at once when its declared length is over, or as soon as the bytes streamed in pass the limit. Each limit sits well above the largest real body measured on a running board:

- `POST /runner/enroll` and `/runner/enroll/poll`, which take no token: 16 KiB (`ENROLL_BODY_LIMIT_BYTES`). The largest body a runner sends, every field at the longest the schema accepts, is under 8 KB, and under 15 KB with every character escaped as `\uXXXX`; a real request is under 200 bytes and a poll 60. The schema bounds no body by itself, since JSON takes any amount of whitespace and zod drops keys it does not know.
- Every `POST`, `PUT`, `PATCH`, and `DELETE` under `/api`, after the token check, so a body without a valid token is never buffered: 1 MiB (`API_BODY_LIMIT_BYTES`), what `/mcp` takes ([board.md](board.md#the-mcp-endpoint-caps-a-requests-size-and-a-tool-calls-elements)), since `/api/verbs` takes the MCP tools' inputs. The largest real one was a knowledge topic of 59,972 bytes. A `GET` is left alone, since looking for a body makes `@hono/node-server` build a whole request.
- A runner's hello, its reports of workspaces and warm sessions, its projection reads, and a turn's steps and outcome: 8 MiB (`RUNNER_BODY_LIMIT_BYTES`). A projection read names 200 paths, and nothing but the CLI's output bounds a batch of steps, as a file a tool call writes whole; the largest real batch was 131,680 bytes, one post with an image inlined as base64, and the largest outcome under 6 KB.
- A runner's answer to a request (`/runner/requests/:id`): 16 MiB (`RUNNER_ANSWER_LIMIT_BYTES`), since it carries a file read on a branch or an image a turn uploads, each up to 8 MiB, as base64, 10.7 MiB.

The home's git route carries packs: it reads one whole and refuses one over 256 MiB only once it has it (`home-git.ts`). `/mcp` sets its own limits. A runner that reads a 413 takes it as a refusal and posts the body no more (`persist` in the daemon): a refused batch of steps is dropped while the turn's later steps go on, a refused answer leaves its request to time out on the server, and a refused outcome never arrives, so the server takes the turn as running until the runner registers again. A refused hello is tried again, every 15 seconds at the longest, as any refusal of a hello is but a 401 before the runner first connected. So no limit may come near a real body.

A 413 closes the connection. `@hono/node-server` drops a connection whose body went unread after the answer, and while the 413 offered to keep it open, a client could send its next request there and see `other side closed`: against a bare hono route, 15 of 30 posts just over 1 MiB, sent between small requests with Node 24's fetch, did. The close stops that, but a client still sending a large body when the connection drops can see `EPIPE` or a reset instead of the 413, which a runner takes for the network and posts again until it reads the 413. With the runner's own client against a server on loopback, 3 to 13 of 30 outcomes over 8 MiB got `EPIPE`, and `persist` stopped after 1 to 7 posts in 60 trials, most often after the first. So a refused body costs a runner a few posts, never an endless retry.

## History

### A job once carried the server's own idea of its address

The MCP address in a job was `STELLARIS_PUBLIC_URL`, defaulting to the host and port the server binds, `http://127.0.0.1:4700` unless set, so an agent on any machine but the server's would have been told to reach the board on its own loopback and failed at its first verb; one value also cannot serve machines that reach the server by different addresses. The job carries `SERVER_TOKEN` now, and the runner fills it with its `STELLARIS_SERVER_URL`.

### A model list once outlived the runner that gave it

The board kept one list per CLI for an hour, asked of whichever runner was least busy, whatever runner the citizen's turns ran on. After the 0.3.6 upgrade the Model… form showed no Effort picker for a Codex citizen pinned to an upgraded runner: the list came from before the runners had the effort levels, and only the hour running out brought them. Lists are now kept per runner, forgotten when it reconnects, and asked of the citizen's own runner.

### A job once went into a stream that delivered nothing

On 2026-10-10 the Kubernetes node under the live runner stopped passing traffic for about six minutes (`NodeNotReady`). The job stream still looked open to the server, which wrote three jobs into it; the runner noticed only when Node's fetch gave up on a body that had been silent for five minutes, reconnected, and listed in its hello the one turn it had, so the hub failed the three as "restarted during the turn" although they had never arrived, and the front desk's `proposal_decided` wake was lost with its turn. Every batch of the running turn's steps that failed to post meanwhile was dropped, cutting six minutes out of its transcript, and every warning said only `fetch failed`. Jobs are acknowledged and sent again now, the runner watches its stream, posts are made again, and warnings name their causes (see [the stream checks](#a-stream-can-look-open-and-deliver-nothing-so-both-ends-check)).
