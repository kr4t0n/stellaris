# The iOS client

How the native client's code is laid out, how the app signs in and keeps its place, how it stays in step with the server, and how it is tested. [AGENTS.md](../../AGENTS.md) states the rules in short, and the commands are in the [README](../../README.md#run-build-test).

## Layout

### `apps/ios` holds the app, BoardKit, and their fixtures

`apps/ios/BoardKit` is a Swift package, BoardKit, for the board's API: Swift 6, for iOS 27.0, and macOS 15 so `swift test` runs on a Mac. `apps/ios/Stellaris` is the SwiftUI app, for iPhone on iOS 27.0, with its unit tests in `StellarisTests` and its UI tests in `StellarisUITests`. `apps/ios/fixtures` holds what the tests read beside the server's and the web's: `api/`, the answers the server's tests capture, and `cases/`, the case tables of the two ports. `apps/ios` has no `package.json`, so pnpm and the TypeScript build leave it alone.

### XcodeGen writes the app's project

`apps/ios/project.yml` names the app's targets, its scheme, its `Info.plist` and its entitlements, and `xcodegen generate` in `apps/ios` writes `Stellaris.xcodeproj` and the two plists into `Generated/`, none of which is committed, so the project never drifts from the spec or carries one person's Xcode settings. `ios.yml` installs XcodeGen 2.46.0 from its release, checked against the digest GitHub lists for the asset.

`Config/Stellaris.xcconfig` holds the three settings that name an Apple developer account and a board: the bundle ID, the team, and the host of the board the app signs in to with GitHub. Its values build for the simulator with no team. A build for a device sets its own in `Config/Local.xcconfig`, which the file includes when it exists and git ignores; `Local.xcconfig.example` shows the three. The host goes into the app's `Info.plist` as `StellarisBoardHost` and into its associated domains as `webcredentials:<host>`.

### BoardKit's core is Foundation alone, and its transport is Apple's

The core builds and tests on Linux with swift.org's toolchain: the models (`Models.swift`), the request builders (`Requests.swift`), the board's refusals (`BoardError`), the server-sent-events parser (`ServerSentEventParser`), the app's GitHub sign-in (`AppSignIn`: the verifier, the landing's address read, and base64url), and the ports of the web's `staleKeys` and `needsYou`. `Transport/` holds what needs Apple's frameworks, compiled only where they exist: `BoardClient`, the API over `URLSession` with the bearer token, the event stream, images, and the sign-in's code trade; the sign-in's S256 challenge, with CryptoKit; and `TokenStore`, the token in the Keychain. Linux's Foundation has no `URLSession.bytes(for:)`, which the event stream reads with, no SHA-256, and no Keychain.

### The models hold what the app reads of the shared schemas

Each model holds the fields of its schema in `packages/shared` that the app reads, under the same names, and decodes a field the schema defaults with the same default. Ids and times stay the strings the board sends, since both sort as text.

The app is installed apart from the server and falls behind its releases, so a value the server adds must not fail an answer, as one invalid item fails a whole list in the web, which the server's own build serves. A value of a closed set, such as a task's status, is an `OrUnknown`: one of the enum's cases, or `unknown` with the raw value, which a view can show as it is. `TaskPhase` has an `unknown` phase for a status the app doesn't know, whose stage waits on nobody, and a proposal of a kind it doesn't know waits on the user, who decides every kind the board has had. The two unions of a message do the same for a shape: a `MessageStep` that is neither a task's step, which names its stage, nor a proposal's, which names only its action, and a `MessageNotice` of a kind other than `knowledge`, or one whose fields don't read as a knowledge topic's, decode as `unknown` with their fields as sent. An event's type stays a string, so an event a newer server adds touches no read. `UnknownValueTests` decodes captured answers with one value or one step or notice changed to one the app doesn't know.

A model whose name Swift or Foundation already uses takes a `Board` prefix: `BoardTask`, `BoardThread`, and `BoardActor`.

### The request builders name every request the app makes

`BoardAPI` builds each read and each verb the app makes as a `BoardRequest`, which knows its answer's type, and the event stream and images as an `Endpoint`, whose answer is bytes. A verb goes to `POST /api/verbs/:verb` with its input's fields named as the verb's schema names them, and a field left empty is left out. Each part of a path is encoded as the web's `encodeURIComponent` encodes it, and a board's address may end in a path of its own. `/auth/config` and the app's sign-in, its start and its code trade, are asked without the token. A refusal is `{error, message}`, or `{error}` alone from the code trade, which answers as OAuth does.

## The app

### Sign-in takes the board's address, then GitHub or a token

The address is `https` only, since every request carries the token; a host alone is taken as `https://<host>`, and a path the board is served under is kept (`BoardAddress`). The app then asks the board's `/auth/config`. It offers GitHub where the board answers `github` and `appLanding` and its host is the one the build names, since iOS hands an `https` callback only to an app associated with the host it is on; anywhere else it takes a token alone.

GitHub's sign-in is the board's app landing ([GitHub sign-in](./runners.md#github-sign-in)) with PKCE. The app makes a verifier (`AppSignIn.makeVerifier`), opens `BoardAPI.appSignIn(challenge:)` in SwiftUI's `WebAuthenticationSession` with the callback `.https(host:path:)` on the board's host and `AppSignIn.landingPath`, in the shared browser session so a GitHub login in Safari carries over, reads the address it lands at (`AppSignIn.landing`: a code, or the board's reason for refusing), and trades the code with the verifier at `/auth/app/token` (`BoardClient.appSession`). A token pasted from the board goes through the same last step: the app keeps a token only once `/api/me` takes it, in the Keychain under the board's address (`TokenStore`), and the address in its defaults.

Once signed in, a 401 on any request drops the token and returns the app to sign-in, saying the board ended the sign-in; a 401 for an earlier sign-in's token ends nothing (`AppModel.send`). Signing out ends a GitHub sign-in on the board too (`DELETE /api/sign-in`), drops the token, and forgets the drafts.

On the inner display folded like a book, the sign-in form moves off the fold: `SignInLayout` takes the fold's frame from `reservedRegions(kind: .division)`, which iOS 27.1 reports, and gives the form the wider side, the trailing one when both are as wide, or above a fold that runs across. Nothing else in the app reads a reserved region; the system's containers move out of a fold by themselves.

### One scene of three tabs

The app has one scene (`UIApplicationSupportsMultipleScenes` is false), whose one window resizes with the display it is on. Its root is a `TabView` of Chat, Board, and Needs you, each with its own navigation stack, and Needs you's badge counts what waits on the user. On a compact width iOS draws the tab bar in the side bar, where a tab shows its icon alone; on the inner display in portrait, where the bar runs along the foot, iOS's default words under the icons stay.

Chat holds the conversation, a channel or a thread. Board lists the society's channels, then each project's channels and its tasks in play, and Needs you lists what waits on the user as the web does; picking any of them opens it in Chat (`AppModel.open`). Back in Chat goes to the conversation Chat showed before, as the web's back arrow follows where the user came from, up to 50 steps (`ChatHistory`); a thread with nothing before it goes back to its channel. Settings, in a sheet from Board, shows the board's address and who the app is signed in as, and signs out.

### What opens, and what each conversation keeps

The app's model lives as long as its process. So coming back from the background shows the conversation that was open, and any fresh start, after iOS or someone ended the app in the background, opens the society's general channel: iOS doesn't tell an app which of the two ended it. Nothing about where the app was is restored at launch.

Each conversation keeps its draft and the message its scroll is anchored at (`ConversationMemory`), saved in the app's defaults per board as they change, so a view built again or a fresh start has them back. The anchor is the message at the foot of the view, read and restored through `scrollPosition(id:anchor:)` with `.bottom`. The scroll view is there from the first frame, empty while the messages load, and anchored at the bottom (`defaultScrollAnchor(.bottom)`) it keeps the foot in view as they come in. The draft is a row below it rather than laid over it, so the foot of the view is the top of the draft and the newest message stays in sight above it. A conversation shorter than the view sits at its foot, by the draft. Tapping the tab in front scrolls its conversation to its top, as iOS does for the tab shown. Chat's tab stays alive while another tab shows, so a trip to Board and back changes nothing.

On the outer display the keyboard covers the side bar, tabs included, until it goes; a scroll of the conversation puts it away (`scrollDismissesKeyboard(.immediately)`).

### Nothing lays out by the screen, the device, or the orientation

The app's window isn't the screen on iPhone Duo, and either display shows it either way round, so a view reads its size classes and its own size. `scripts/ios/check-adaptivity.sh`, part of `pnpm lint` and so of `check`, refuses `UIScreen.main`, the interface idiom, and the device's or the interface's orientation in the app's sources and BoardKit's. Before it reads them it plants a line of each kind it refuses in a scratch folder and stops unless it catches every one. The UI tests set the simulator's orientation, which is why they are outside what it reads.

## Keeping the client in step with the server

### The server's tests capture what the client reads

`apps/server/src/ios-fixtures.test.ts` starts a test society (`startTestSociety`) that signs in with GitHub and names an app, with GitHub itself faked, lets scripted citizens post, ask the user, file tasks and proposals, and update a dashboard through the verbs, then makes each request BoardKit makes, as the user over HTTP: the reads, the verbs, three refusals, and the event stream. `me` and the sign-out are captured twice, with the user's own token and with a GitHub sign-in's, whose answer names the account, and a channel again once a knowledge topic's notice is in it. The app's sign-in is captured step by step: its start with RFC 7636's example challenge, the landing GitHub's return sends the browser to, with a code and with a refusal, the code's trade with the example's verifier, and a second trade the board refuses. A step in the browser keeps where the board sends it, and the state, the code, and the session the board makes up become fixed names. It compares each answer with `apps/ios/fixtures/api/<name>.json` through `toMatchFileSnapshot`. Ids become placeholders numbered by where the capture first met them, the same in every fixture, and every time becomes one constant, so a capture is the same on every run.

So a server change that alters any answer the client reads fails `pnpm test`, and with it `check`. Capture again with `pnpm vitest run apps/server/src/ios-fixtures.test.ts -u` after `pnpm build`, and read the fixtures' diff: the change runs `ios.yml`, where BoardKit's tests say whether the client still reads the new answers. oxfmt leaves `apps/ios/fixtures/api` alone, since the test writes it.

### BoardKit decodes every fixture and rebuilds every request

`FixtureTests` decodes each fixture with the type its request names, then builds the request from the ids the answer gives, or for a verb from the input the capture sent, and checks its method, path, and body against the captured ones. A sign-in landing is read with `AppSignIn.landing`, as the app reads it, and on Apple's platforms `AppSignInTests` checks that the challenge the app makes from the captured verifier is the one the board checked it against. Its list of checks must name every fixture, so a request the app starts to make needs a capture in the server's test and a check in `FixtureTests` in the same change. `needsYou` also runs over the captured proposals, tasks, and questions. The event stream's fixture is the server's own text, which the parser's tests read whole and in pieces of every size.

### The two ports run the web's case tables

`staleKeys` in `apps/web/src/lib/events.ts` and `needsYou` in `apps/web/src/board/governance.ts` each have a port in BoardKit and a case table in `apps/ios/fixtures/cases`. The web's `events.test.ts` and `governance.test.ts` run each table against the web's function, importing it with Vite's `?raw`, and BoardKit's `CaseTableTests` run it against the port. A change to either function changes its table, which fails BoardKit's tests until the port follows. The `staleKeys` table holds a case for every type in `BOARD_EVENT_TYPES`, which the web's test checks.

## Tests and CI

### BoardKit's tests run on Linux and on the simulator

`swift test` in `apps/ios/BoardKit` runs them with Swift 6 on Linux or macOS; on Linux the transport's tests are compiled out with it. `xcodebuild test -scheme BoardKit -destination 'platform=iOS Simulator,name=iPhone Duo,OS=27.1'` in the same folder runs them all on the simulator with Xcode 27.1. The transport's tests answer through a stub `URLProtocol`, each test under a host of its own since Swift Testing runs tests in parallel. The simulator's Keychain turns away a package's tests with `errSecMissingEntitlement`, since they run in no app, so `TokenStore`'s test runs only where the Keychain takes the test process, as on macOS. The tests find the fixtures from their own source path, so they run from a checkout.

### The app's tests run against a fake board

`FakeBoard`, compiled into debug builds only, is a `URLProtocol` that answers `https://board.example.com` from `apps/ios/fixtures/api`, with sixty made-up messages in the society's general channel, enough to scroll. The app uses it when launched with `STELLARIS_FAKE_BOARD` set to that folder, and starts with no token and no defaults when launched with `-StellarisReset`. It takes any token but two: `refused`, which it never takes, and `revoked`, which it takes for sign-in and refuses on every request after. The tests find the folder from their own source path, as BoardKit's do, and the simulator's processes read it from the checkout.

`StellarisTests`, hosted in the app, test the model against the fake board with tokens in memory: signing in, a refused and a revoked token, a fresh start, Chat's history, and signing out; and `ChatHistory`, `BoardAddress`, `SignInLayout`, and `ConversationMemory` alone. `StellarisUITests` drive the app on the simulator, finding elements by type and identifier, since a query over every descendant can keep the app answering past XCTest's timeout. They find the conversation's scroll view by its identifier, `messages`, since with the keyboard up the first scroll view is the keyboard's row of suggestions, they send the app to the background by bringing Settings to the front, since pressing Home on the iPhone Duo simulator leaves it in front, and they never tap the tab in front, which would scroll it to its top. They cover the draft and the scroll position kept through a trip to Board and back, Back retracing what Board and Needs you opened, the last conversation back from the background and general after a fresh start, the two tokens the board turns away, and signing out. `ScreenUITests` keeps a screenshot of each screen. Setting the orientation leaves the simulator's outer display as it is, so a rotation is checked in Device Hub.

### The snapshot harness draws each view at each width

`Snapshot` in `StellarisTests` hosts a view in a window of a fixed size and keeps a picture of it with the test's results: at 320 points wide, the narrowest Split View the app is laid out for; 410, the outer display less its bar; 450, a column of the inner display folded like a book; and 669 and 951, the inner display in portrait and landscape; each at the default and the largest type size, with a regular width from 600 points. Nothing compares the pictures with earlier ones: they are for review, and the tests fail only when a view can't be drawn. `testCapturesASystemList` shows the harness draws a system list's rows, by finding a row's colour in the picture of a `List` and not in an empty one. iOS places its vertical bar by the display the simulator shows, so in a window no wider than the outer display the pictures show the side bar as there, and in a wider one the harness turns the vertical bar off (`toolbarVerticalBehavior(.disabled)`, iOS 27.1) and the bars run horizontal, as on the inner display in portrait. Where the bars go on the open phone is checked in Device Hub.

### `ios.yml` runs on macOS, and no rule requires it

`.github/workflows/ios.yml` runs BoardKit's tests on GitHub's `xcode-27` runner, on the iPhone Duo simulator with iOS 27.1, then with `swift test` on the runner's macOS for the Keychain, with Xcode 27.1 named by `DEVELOPER_DIR` rather than taken from the image's default. Its `app` job generates the app's project, runs the app's unit and UI tests on the iPhone Duo simulator, looks at which of the simulator's displays `simctl io` can capture with the app open, and keeps every picture, the tests' attachments exported with `xcresulttool`, as the `screens` artifact. The iPhone Duo simulator boots closed, showing the app on the outer display at 466 by 678 points in portrait. `XCUIScreen.screens` lists both displays and screenshots each, but the inner one, 669 by 951 points, is black while the phone is closed, and nothing in CI opens or folds the simulator, so the inner display, the fold, and the poses are checked on the device or in Device Hub. It runs on pull requests and pushes that change `apps/ios` or the workflow, the fixtures included. The branch rules don't require it, since GitHub leaves a required workflow that its paths skipped pending, which blocks the merge. So a reviewer reads its run on a pull request that changes `apps/ios`.
