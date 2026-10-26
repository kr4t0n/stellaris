# The iOS client

How the native client's code is laid out, how it stays in step with the server, and how it is tested. [AGENTS.md](../../AGENTS.md) states the rules in short, and the commands are in the [README](../../README.md#run-build-test).

## Layout

### `apps/ios` holds BoardKit and its fixtures

`apps/ios/BoardKit` is a Swift package, BoardKit, for the board's API: Swift 6, for iOS 27.0, and macOS 15 so `swift test` runs on a Mac. `apps/ios/fixtures` holds what its tests read beside the server's and the web's: `api/`, the answers the server's tests capture, and `cases/`, the case tables of the two ports. `apps/ios` has no `package.json`, so pnpm, the TypeScript build, and the lint leave it alone.

### BoardKit's core is Foundation alone, and its transport is Apple's

The core builds and tests on Linux with swift.org's toolchain: the models (`Models.swift`), the request builders (`Requests.swift`), the board's refusals (`BoardError`), the server-sent-events parser (`ServerSentEventParser`), and the ports of the web's `staleKeys` and `needsYou`. `Transport/` holds what needs Apple's frameworks, compiled only where they exist: `BoardClient`, the API over `URLSession` with the bearer token, the event stream, and images; and `TokenStore`, the token in the Keychain. Linux's Foundation has no `URLSession.bytes(for:)`, which the event stream reads with, and no Keychain.

### The models hold what the app reads of the shared schemas

Each model holds the fields of its schema in `packages/shared` that the app reads, under the same names, and decodes a field the schema defaults with the same default. Ids and times stay the strings the board sends, since both sort as text.

The app is installed apart from the server and falls behind its releases, so a value the server adds must not fail an answer, as one invalid item fails a whole list in the web, which the server's own build serves. A value of a closed set, such as a task's status, is an `OrUnknown`: one of the enum's cases, or `unknown` with the raw value, which a view can show as it is. `TaskPhase` has an `unknown` phase for a status the app doesn't know, whose stage waits on nobody, and a proposal of a kind it doesn't know waits on the user, who decides every kind the board has had. An event's type stays a string, so an event a newer server adds touches no read. `UnknownValueTests` decodes captured answers with one value changed to one the app doesn't know.

A model whose name Swift or Foundation already uses takes a `Board` prefix: `BoardTask`, `BoardThread`, and `BoardActor`.

### The request builders name every request the app makes

`BoardAPI` builds each read and each verb the app makes as a `BoardRequest`, which knows its answer's type, and the event stream and images as an `Endpoint`, whose answer is bytes. A verb goes to `POST /api/verbs/:verb` with its input's fields named as the verb's schema names them, and a field left empty is left out. Each part of a path is encoded as the web's `encodeURIComponent` encodes it, and a board's address may end in a path of its own. Only `/auth/config` is asked without the token.

## Keeping the client in step with the server

### The server's tests capture what the client reads

`apps/server/src/ios-fixtures.test.ts` starts a test society (`startTestSociety`), lets scripted citizens post, ask the user, file tasks and proposals, and update a dashboard through the verbs, then makes each request BoardKit makes, as the user over HTTP: the reads, the verbs, three refusals, and the event stream. `me` and the sign-out are captured twice, with the user's own token and with a GitHub sign-in's, whose answer names the account. It compares each answer with `apps/ios/fixtures/api/<name>.json` through `toMatchFileSnapshot`. Ids become placeholders numbered by where the capture first met them, the same in every fixture, and every time becomes one constant, so a capture is the same on every run.

So a server change that alters any answer the client reads fails `pnpm test`, and with it `check`. Capture again with `pnpm vitest run apps/server/src/ios-fixtures.test.ts -u` after `pnpm build`, and read the fixtures' diff: the change runs `ios.yml`, where BoardKit's tests say whether the client still reads the new answers. oxfmt leaves `apps/ios/fixtures/api` alone, since the test writes it.

### BoardKit decodes every fixture and rebuilds every request

`FixtureTests` decodes each fixture with the type its request names, then builds the request from the ids the answer gives, or for a verb from the input the capture sent, and checks its method, path, and body against the captured ones. Its list of checks must name every fixture, so a request the app starts to make needs a capture in the server's test and a check in `FixtureTests` in the same change. `needsYou` also runs over the captured proposals, tasks, and questions. The event stream's fixture is the server's own text, which the parser's tests read whole and in pieces of every size.

### The two ports run the web's case tables

`staleKeys` in `apps/web/src/lib/events.ts` and `needsYou` in `apps/web/src/board/governance.ts` each have a port in BoardKit and a case table in `apps/ios/fixtures/cases`. The web's `events.test.ts` and `governance.test.ts` run each table against the web's function, importing it with Vite's `?raw`, and BoardKit's `CaseTableTests` run it against the port. A change to either function changes its table, which fails BoardKit's tests until the port follows. The `staleKeys` table holds a case for every type in `BOARD_EVENT_TYPES`, which the web's test checks.

## Tests and CI

### BoardKit's tests run on Linux and on the simulator

`swift test` in `apps/ios/BoardKit` runs them with Swift 6 on Linux or macOS; on Linux the transport's tests are compiled out with it. `xcodebuild test -scheme BoardKit -destination 'platform=iOS Simulator,name=iPhone Duo,OS=27.1'` in the same folder runs them all on the simulator with Xcode 27.1. The transport's tests answer through a stub `URLProtocol`, each test under a host of its own since Swift Testing runs tests in parallel. The simulator's Keychain turns away a package's tests with `errSecMissingEntitlement`, since they run in no app, so `TokenStore`'s test runs only where the Keychain takes the test process, as on macOS. The tests find the fixtures from their own source path, so they run from a checkout.

### `ios.yml` runs on macOS, and no rule requires it

`.github/workflows/ios.yml` runs BoardKit's tests on GitHub's `xcode-27` runner, on the iPhone Duo simulator with iOS 27.1, then with `swift test` on the runner's macOS for the Keychain, with Xcode 27.1 named by `DEVELOPER_DIR` rather than taken from the image's default. It runs on pull requests and pushes that change `apps/ios` or the workflow, the fixtures included. The branch rules don't require it, since GitHub leaves a required workflow that its paths skipped pending, which blocks the merge. So a reviewer reads its run on a pull request that changes `apps/ios`.
