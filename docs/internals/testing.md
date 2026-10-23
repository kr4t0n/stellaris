# Testing

How the tests are laid out, what makes them slow or flaky, and the probes that check what a test cannot. [AGENTS.md](../../AGENTS.md) states the rules in short; the commands are in the [README](../../README.md#run-build-test), and CI's chain is on [delivery.md](delivery.md#ci).

## Running the checks

### Run them in a clean environment

`env -i HOME="$HOME" PATH="$PATH" TMPDIR=<folder of your own> LANG=C.UTF-8 HUSKY=0 <command>` runs a check with nothing from the calling shell but what it needs: no `NODE_ENV` (below), no token a turn holds, and the test temp folders in a folder of your own. `HUSKY=0` keeps husky's install out of the clone's configuration (see [the default-branch guard](workspaces.md#a-merge-projects-default-branch-moves-only-by-the-runner)).

### `NODE_ENV=development` makes a development bundle

`apps/web`'s `build` is a plain `vite build`, so with `NODE_ENV=development` in the environment it bundles React's development build, larger and with `jsxDEV` in many chunks. For a size or bundle comparison, or an e2e run meant to match CI, build with `NODE_ENV=production pnpm build:web`, set on that command alone: exported, it makes `pnpm install` skip the devDependencies.

### What a run leaves

Build output is ignored (`dist/`, `build/`, `*.tsbuildinfo`, `release/`, `node_modules/`), and so are Playwright's `test-results/` and `playwright-report/`. `git status --short --ignored` lists what a run left, and `git clean -fdX` removes it.

## Where tests live

### Tests live beside the code

Tests live beside the code as `*.test.ts` and run with Vitest from the root. `board-core` and scheduler tests use a temporary data directory and an injected clock. `apps/server/src/integration.test.ts` and `runner.test.ts` run the whole loop with a scripted backend standing in for the CLI, on a server and a runner in one process talking the runner protocol over real HTTP (`startTestSociety` in `apps/server/src/testing/harness.ts`). The interface's browser tests are `apps/web/e2e/*.spec.ts`, run by Playwright against the built interface with every `/api` request answered by the fake board in `e2e/board.ts`; a new write the interface makes needs a fake there, and anything unanswered gets a 404 rather than reaching a board. The exception is Phase 7's exit test, `e2e/society.spec.ts` in the `society` project, which starts a board server and a runner of its own for each test (`startSocietyServer` in `apps/server/src/testing/society-server.ts`, imported from the server's build) on a fresh society with the scripted backend: each scripted turn waits at a checkpoint until the test posts `/test/release` for its citizen, and the test reads the sky through its copy for keyboards and screen readers, whose task entries (`markLabel` in the sky model) name the stage, the phase, the holder, and the link.

### A test that imports another workspace package reads its build

Vitest runs each package's own tests from source, but a test that imports another workspace package, as `apps/server`'s tests import `@stellaris/runner-core` and every package imports `@stellaris/shared`, reads that package's `dist/`, since every package's `exports` point there. So a change in `packages/*/src` that only another package's tests cover reaches them only after `pnpm build`, and a test run without one tests the old build.

### Vitest hides what passing tests print

Vitest 5 shows no console output from a test that passes; pass `--silent=false` to see a probe's `console.log`.

## Timeouts and load

### Every test gets 30 s

`vitest.config.ts` sets `testTimeout: 30_000` for the whole suite rather than per test, since which git-heavy tests run past Vitest's 5 s default depends on the machine's load; the slowest take up to about 20 s on a loaded 4-CPU machine. `hookTimeout` keeps Vitest's 10 s. A test that times out under load is no regression until the base's version, run beside it at the same load, passes.

### `pnpm test -- --testTimeout=…` keeps the configured timeout

pnpm passes the `--` on to Vitest, which ignores every option after it. Write `pnpm test --testTimeout=60000` or `pnpm exec vitest run --testTimeout=60000`.

### The resident-session test in `runner.test.ts` fails under heavy load whatever the timeout

It runs with `residentIdleMs: 1_000`, so when more than a second passes between its first two turns the session idles out and starts again, and `backend.starts` holds two entries where it expects one. Run it alone at a lower load before reading it as a regression.

### A test that times out can leave its temp folder

Its body goes on running after Vitest gives up on it, so its cleanup races the test's own writes, may fail with `ENOTEMPTY`, and leaves the `stellaris-*` folder in the temp directory. Point `TMPDIR` at a folder of your own and delete it after the run.

## Scheduler and server tests

### The scheduler test's fake runner records turns only when asked

`setup({ record: true })` makes it write turn records through the board on the injected clock; the reflection test needs that because the cadence reads `last-turn.json`. Other tests leave it off, so their idle-member and spend signals stay as they were.

### Timestamps in the reflection rule come from two clocks

The scheduler compares a turn record's `endedAt`, written by the runner, with its own `lastReflection`. In production both are wall time; a test that advances an injected scheduler clock while the runner uses wall time sees every later turn as older than the last reflection, which is harmless there but explains a missing dispatch.

### A scheduler test harness must run the onboarding turns to completion first

With a concurrency cap of one, a leftover onboarding dispatch merges with a later mention and swaps the expected order.

### A runner's disconnect is recorded after its stream closes, so stop the hub before deleting a society

The server notices a closed stream asynchronously and then writes the runner's state and a `runner.changed` event. A test that stopped its runner and removed the data directory at once failed one run in three with `ENOTEMPTY` on `events/`; `RunnerHub.close` marks every stream closed and waits for the disconnects under way, and the test harness and the server's shutdown call it.

### Claude Code will not wait on a foreground `sleep`

It refuses `sleep N && …` in the foreground ("use Monitor") and backgrounds long waits, and a background task dies with the CLI when a cold turn ends. A live test that needs a turn to stay busy waits with something else, such as `python3 -c "import time; time.sleep(30)"`. Interrupting a turn while a background task runs makes the CLI exit with code 1 once its input ends, which the adapter reports as the stop.

## Browser tests

### The exit test needs a society to itself

Playwright starts a `webServer` once per run, so `--repeat-each` copies on two workers once drove one society together, and later copies met the earlier ones' tasks. Each test starts its society server in the test process, on port 0, and the server's `stop()` closes every connection, because the page's event streams never end and `server.close()` would wait for them forever.

### The core's first seat is at the center of the sky

Sunflower packing puts the first citizen's seat at the core's center, so in the home view a click at the canvas's center opens that citizen, not the society. The drag test once asserted the society and passed only while the camera was still easing back after "Fit the whole sky", which put the click off the star; it failed about one run in ten. It runs with reduced motion now, so the camera lands without easing, but still on the scene's next frame, since `home()` only sets the mode: in the 0.2.0 release's CI the last click came in the same frame as "Fit the whole sky", hit the panned view, and opened nothing, about one run in fifty, so the test waits two animation frames before it.

### A same-document navigation does not reload the interface

`takeSignIn` runs once, before the first render, which is all the GitHub callback needs, since it arrives as a new document. A browser test that goes to an address differing from the current one only in its fragment stays in the same document and never reads it; `e2e/runners.spec.ts` goes to `about:blank` first.

### A URL's own `..` never reaches a route

The WHATWG URL parser resolves `.` and `..` segments, `%2E%2E` included, before a request leaves the client, so `/api/tasks/<id>/files/a/%2E%2E/b` arrives as `/files/b`. A test of the server's refusal of `..` has to hide the dot segments behind encoded slashes (`a%2F..%2Fb`), which Hono decodes into the path parameter that `BranchPathSchema` refuses.

### Running the suite

- `playwright.config.ts` serves the built interface on the fixed port 4174 with `reuseExistingServer: false`, so two runs on one machine collide (`http://127.0.0.1:4174 is already used`). To run beside another, copy the config into a folder outside the repo with a `node_modules` link to `apps/web/node_modules`, so it resolves the same `@playwright/test` as the specs (a config beside another copy fails with "Requiring @playwright/test second time"), and change `testDir` to the absolute path of `apps/web/e2e`, `outputDir` to that folder, the chromium project's `baseURL` and the `webServer` command to a spare port, with `cwd` set to `apps/web`; run `playwright test --config <that file>` from `apps/web`.
- The config's `webServer` runs a bare `vite preview`, which `pnpm test:e2e` puts on `PATH`; calling `playwright test` directly in a clean environment needs `apps/web/node_modules/.bin` on `PATH`, or the server fails with `vite: not found`.
- The `society` project starts board servers on port 0 of its own and imports the server's build, so it needs `pnpm build` first.
- Name a project as `--project=chromium`: `--project chromium citizens.spec.ts` reads the file as a second project name.
- `CI=1` gives `forbidOnly` and the `github` reporter, as on GitHub.

### Writing specs

- `locator.boundingBox()` waits out the whole test timeout for an element that never appears, so put an `expect(…).toBeVisible()` before it.
- `page.waitForLoadState("networkidle")` never settles, because the interface polls and streams. Wait for the DOM.
- `test.use({ launchOptions })` forces a new worker, which Playwright refuses inside a `describe`; put it at the top of the spec file, as `e2e/layout.spec.ts` does.
- The interface's `QueryClient` sets `refetchOnWindowFocus: false`, so focus events refetch nothing, and it polls `/api/scheduler` every 3 s, so a change in the fake board's working state shows within about 3 s.
- The router keeps a route's view mounted when only its params change. `ThreadView` and `ChannelView` key their whole stream by id, while `TaskView` and `ProposalView` key only their message list, so state a hook keeps in the view's own body carries from one task or proposal to the next, as when a blocker's link leads from one cached task to another.

### The fake board

- `fakeBoard` in `e2e/board.ts` answers every `/api` request; a `page.route` registered after it wins over it for the same address. `route.fetch()` sends a request to the network, which is the preview's closed port, not to the fake, so a different answer is an option on `fakeBoard`. It returns `writes`, the path and body of each verb call the interface made.
- The interface parses every answer with the shared schemas, and one invalid item fails the whole list: a runner name over 32 characters (`NameSchema`) made `/api/runners` fail, and the runners view showed no Plan quota section and no error.
- To hold an answer back until the test says so, register a route after `fakeBoard` that awaits a promise and then calls `route.fallback()`, as `metrics.spec.ts` does; a fixed delay only makes a race likely.
- To make the interface refetch mid-test, answer `**/api/events/stream**` with one frame, `data: <BoardEvent JSON>` and a blank line: `staleKeys` invalidates what that event type touches, the body ends, the client reconnects a second later, and `onResume` invalidates every query. The event's `id` must be a ULID.
- The fake holds the turn stream open and empty; answer `**/api/turns/stream**` with `turn_started` and `text` frames to give a citizen a live turn.

### Scrolling, focus, and touch

- Setting `scrollTop` in `evaluate` fires `scroll` only on the next frame, so a retrying assertion right after it can pass before the interface has seen the scroll. In the same `evaluate`, wait for the `scroll` event and two animation frames.
- A `click` listener on `window` runs after React's handler and the layout effects it flushes, so a list's position read there is where the click left it, before any frame: that tells a smooth scroll from an instant one without timing. Chromium's programmatic smooth scroll takes longer the further it goes, a second or more for a few thousand pixels on a loaded machine, and `page.emulateMedia({ reducedMotion: "reduce" })` switches `prefers-reduced-motion` mid-test.
- Touch scrolling needs a context with `hasTouch: true` and CDP `Input.dispatchTouchEvent` (`touchStart`, several `touchMove`s, `touchEnd`); `Input.synthesizeScrollGesture` with `gestureSourceType: "touch"` scrolls nothing.
- oxlint's `react(immutability)` refuses `el.tabIndex = -1` on an element taken from a hook's ref through an array spread; `el.setAttribute("tabindex", "-1")` passes.

### Scrollbars and other browsers

- Headless Chromium reads every scrollbar as 0 px (see [Chromium and scrollbars](interface.md#chromium-drops-the-webkit-scrollbar-styles-on-any-element-that-sets-scrollbar-width-or-scrollbar-color)). With `--hide-scrollbars` dropped, Chromium's `scrollbar-width: thin` takes 10 px and the app's `::-webkit-scrollbar` style 6 px.
- Playwright's Firefox (1.63) loads a stylesheet that sets `scrollbar-width: none` on every box whenever it runs headless, so headless Firefox can check scroll positions and events but never a drawn scrollbar. It also rounds and scrolls differently: a wheel moves a list far less than Chromium's in the same time, and `scrollHeight` and an end `scrollTop` can round down where Chromium's round up.
- Chromium can resolve the other browsers' rules: `scrollbar-width: initial` on a box makes it follow the `::-webkit-scrollbar` rules alone, as WebKit does, and adding `@layer base { * { scrollbar-width: thin } }` with `page.addStyleTag` gives the cascade Firefox resolves, since `styles.css` sets that only where `::-webkit-scrollbar` is unsupported.

### Layout

- The content island's resize handle is `getByRole("button", { name: /^Width of the board's content/ })`, its accessible name gives the width, and `ArrowRight` narrows it by 32 px and `ArrowLeft` widens it. An init script setting `localStorage` `stellaris.contentWidth` to a number sets the island to that width from the first frame.
- Measure an item relative to its scroller (`rect.y - scroller.y + scrollTop`), not by `offsetTop`, which changes with any new positioned wrapper.
- The Citizens list's rows are subgrids as wide as every column together, so their own `scrollWidth` never shows overflow; read sideways overflow on the list's scroller. A grid item's box spans its whole column, so check where text is drawn with a `Range` over the cell's text nodes.

### What the first page loads

The first page loads the chunks `index.html` names (`grep -o 'assets/[^"]*\.js' <out>/index.html`) and what they import. `board/compose.ts` loads with it, because the ask box uses it, so anything it imports is eager. Rolldown puts its runtime helpers in one chunk that `index` imports from wherever they landed, which is how re-exporting micromark from `shared`'s root once moved them into the parser's chunk (see [mentions](board.md#a-mention-is-an-name-outside-code)). Hashes cascade, since chunks import helpers from `index`, so compare a build with the base's by chunk name with the hash stripped.

`git archive origin/dev apps/web` into a scratch folder with a `node_modules` link to `apps/web/node_modules`, then `NODE_ENV=production vite build` there, builds the base's interface against the branch's `packages/shared` build in seconds, which holds while the branch only adds to `shared`; `vite preview --outDir <dir>` serves either build on a spare port.

## Probes

### A real server and runner by hand

The tests run the runner protocol in one process and the e2e specs answer `/api` from a fake, so a change to the hello, the runner record, or `/api/runners` is checked end to end only by hand. After `pnpm build`, in a scratch folder `$D`:

- `node apps/cli/dist/index.js --data $D/data --json init --name probe` prints `{dataDir, userToken}`, and `… --json runner add <name>` prints `{runner, token}`. Run both before the server starts, since the CLI writes the data directory directly.
- `STELLARIS_DATA_DIR=$D/data STELLARIS_PORT=<spare> STELLARIS_WEB_DIR=<repo>/apps/web/dist node apps/server/dist/index.js` starts the server, which serves the built interface too; a Playwright probe can run against it with the token set in `localStorage` (`stellaris.token`) by an init script. While it runs, add runners with `POST /api/runners`.
- `HOME=<a folder of its own> GIT_CONFIG_NOSYSTEM=1 STELLARIS_SERVER_URL=http://127.0.0.1:<spare> STELLARIS_RUNNER_TOKEN=<token> STELLARIS_RUNNER_DIR=$D/runner STELLARIS_CLIS=claude node apps/runner/dist/index.js` registers a runner in about a second; without the token it enrolls and logs the code. A `HOME` per runner gives each its own global gitconfig and no CLI login: there Claude Code's usage read answers `rate_limits_available: false`, recorded as `status: none`, and Codex's `account/rateLimits/read` refuses, a 500 from the quota route.
- Stop the runners and the server by PID, and wait for each to exit before deleting `$D`.

To check an older build against a newer one, `git archive` the base into a folder, install, and `tsc -b` there, then run the base's runner against the branch's server and the reverse. Zod objects strip unknown keys, so an older server's schema accepts a newer outcome and drops its new fields, which a node script parsing the new object with the base's `packages/shared/dist` shows.

### Scripts against the board

After `pnpm build`, a `.mts` script run with the root `node_modules/.bin/tsx` can import `packages/board-core/dist/index.js` (a `.ts` one is compiled as CommonJS and refuses top-level await). `Board.init(dir, { name })` makes a society; `Board.open(dir, { now: () => new Date(clock) })` opens it on a clock the script moves, so `addWorkRoles` from `apps/server/dist/testing/scripted-backend.js`, `addAgent`, and `beginTurn` and `finishTurn` per turn record turns at chosen times (`usage: null` records one without a count). An event log written by hand is JSONL lines of `{id, ts, type, actor, payload}` with 26-character Crockford ids in order, appended to `new BoardPaths(dir).eventLog()` before `Board.open`, which makes an oracle for anything summed over the log: compare `tokenUse` with `listTurns` summed over the same window, for one.

To time the mention parse on the write path, post a large body with `postMessage(USER, { channel, body })` (`USER = { name: "user", role: "user" }`) right before a one-line post, with a 10 ms `setInterval` measuring the longest stall of the event loop; end each body with a name in a code span and a plain name, so the stored `mentions` say whether the post was parsed or fell back to counting every name.

To run several of one citizen's conversations at once, a test of your own beside `apps/server/src/integration.test.ts` can use `startTestSociety` with a backend whose `runTurn` reads its conversation from `board.resolveToken(request.mcp.token)` (`scope`, `thread`, `channel`) and its worktree from `request.spec.cwd`; `society.run({ agent, project, channel, thread, trigger, priority })` runs one turn start to finish, so `Promise.all` of several keeps them in flight together, and turns that wait on a shared promise inside `runTurn` overlap for sure.

### A CLI against a stub model service

To see what a real CLI does with an answer from the model service, such as an overload or a server error, drive the built adapter against a stub on 127.0.0.1, with no login and nothing billed. Run a small HTTP server that answers what the case needs, and a node script that imports `CodexBackend` or `ClaudeAgentBackend` from the build with `recordDir` set and calls `runTurn`. Run the script under `env -i` with `HOME` and the CLI's config folder in a scratch folder, and with `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` at `127.0.0.1:9` and `NO_PROXY=127.0.0.1`, so nothing else leaves the machine.

- **Claude Code:** the backend's `env` takes `ANTHROPIC_BASE_URL` (the stub), `ANTHROPIC_API_KEY` (any value) and `CLAUDE_CONFIG_DIR`. The stub answers `POST /v1/messages` with the status and an `{"type":"error","error":{…}}` body.
- **Codex:** a `config.toml` in the scratch `CODEX_HOME` sets `model_provider` to a `[model_providers.<name>]` entry with `base_url` at the stub's `/v1`, `wire_api = "responses"`, and an `env_key`. The stub answers `POST /v1/responses` with a server-sent event stream (`response.created`, `response.output_item.done` with an `output_text` message, and `response.completed` with `usage`) or with an error status and body. Rate-limit headers (`x-codex-primary-used-percent`, `-window-minutes`, `-reset-at`) make Codex report them. The backend's `codexPath` runs another Codex version, unpacked from `npm pack @openai/codex@<version>-linux-x64` with no install scripts.
- **Codex's remote compaction** runs only for a provider Codex takes for OpenAI's or Azure's, so name the stub's provider `azure` and set `model_auto_compact_token_limit` low. The compaction is a request to `/v1/responses` whose last input item is `{"type":"compaction_trigger"}`, and its answer is one output item `{"type":"compaction","encrypted_content":…}`.
- **A `legacy` Codex thread**, the history mode a release before 0.151.0 or a store without its SQLite state database creates, comes from a `spawn` wrapper. It sets `capabilities.experimentalApi` on `initialize` and `historyMode: "legacy"` on `thread/start`.

### Parsers and recorded streams

- To parse the repository's TypeScript in a probe, import `parseAst` from rolldown's `dist/parse-ast-index.mjs` and call it with `{ lang: "ts" }` or `"tsx"`; it gives an ESTree tree with `start` and `end` offsets. TypeScript 7's root export holds only `version` and `versionMajorMinor`, and its API is under `typescript/unstable/sync`.
- Two oracles check what markdown is code: cmark-gfm, GitHub's C parser, from pip as `cmarkgfm` (`github_flavored_markdown_to_html(text, options=Options.CMARK_OPT_FOOTNOTES)`, which omits raw HTML and puts a fence's info string on `<pre lang>`), and `gh api markdown -f mode=gfm -f text='…'`, which renders as github.com does and stores nothing. micromark differs from cmark-gfm in a few places, such as an autolink literal taking a backtick into its URL and `<!-- … --->` closing a comment, so check a mismatch against micromark's own output.
- The adapters' recorded fixtures replay through `replay()` in each adapter's `quota.test.ts`: a `queryFn` yielding the fixture's SDK messages for Claude, and a fake `spawn` answering each request with its recorded response for Codex. A probe can edit one field of one recorded event and run the turn. `codex app-server generate-ts --out <folder> --experimental` writes the installed Codex's protocol types with no login, with `HOME` set to a scratch folder.
- A request whose input fails the runner's message schema is skipped by the runner (`onMalformed` logs it), and the hub waits out the request's timeout, 60 s for a file read (`FILE_TIMEOUT_MS` in `turn-host`), before it answers 503. So feed a verb that forwards input to a runner every input the runner's schema refuses.
