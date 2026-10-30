# Running the iOS app on an iPhone

How to build the iOS app on a Mac, install it on your own iPhone, and sign in to your board. The commands for the app's tests are in the [README](../../README.md#run-build-test), and how the app works in [docs/internals/ios.md](../internals/ios.md).

## What you need

- A Mac with Apple silicon on macOS Tahoe 26.6 or later, which Xcode 27.1 needs.
- An iPhone on iOS 27.0 or later. The app is for iPhone only. Pairing it with the Mac takes a cable, or the same Wi-Fi network.
- An Apple Account that is a member of the Apple Developer Program. The app is always signed with the Associated Domains capability, which a free account can't sign ([what the membership is for](#what-the-membership-is-for)).
- A board on an `https` address whose certificate the iPhone trusts. To sign in with GitHub, the board must also be reachable from the public internet, and you need to be able to change its configuration.

## 1. Set up the Mac

### Xcode and the iOS platform

1. Install Xcode 27.1 from the Mac App Store or from [Apple's downloads](https://developer.apple.com/download/applications/).
2. Open it once. When it asks which platforms to install, choose iOS. If you skip that, install it later under **Xcode > Settings > Components**, Platform Support: without it, Xcode can't build for a device.
3. Check which Xcode the command line uses, since `xcodegen` and `xcodebuild` follow it:

   ```bash
   xcodebuild -version                  # Xcode 27.1
   sudo xcode-select -s /Applications/Xcode.app   # only if it named another Xcode; give Xcode 27.1's path
   ```

### XcodeGen

The app's Xcode project is generated from `apps/ios/project.yml` and never committed. Install XcodeGen 2.46.0 as CI does, from its release, checked against the digest GitHub lists for the asset:

```bash
mkdir -p ~/.local
curl -fsSL -o ~/.local/xcodegen.zip https://github.com/yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip
echo "4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806  $HOME/.local/xcodegen.zip" |
  shasum -a 256 -c - && unzip -q ~/.local/xcodegen.zip -d ~/.local && rm ~/.local/xcodegen.zip
export PATH="$HOME/.local/xcodegen/bin:$PATH"   # add this line to ~/.zprofile to keep it
xcodegen --version                               # Version: 2.46.0
```

`shasum` must print `…/xcodegen.zip: OK`, and only then does the zip unpack. If it prints `FAILED`, delete the file and stop. Keep the unzipped `xcodegen` folder whole: the binary reads the presets in `xcodegen/share` beside it.

### The checkout

```bash
git clone https://github.com/kr4t0n/stellaris.git
cd stellaris
git switch dev        # main holds the latest release; dev holds what comes next
```

Build from the branch or tag whose app you want to try, and check that your board serves it ([Which board the app needs](#which-board-the-app-needs)).

## 2. Apple's side

### Your team ID

Sign in to your account on [developer.apple.com](https://developer.apple.com/account). **Membership details** shows your Team ID, a 10-character string such as `ABCDE12345`.

Add the same Apple Account to Xcode under **Xcode > Settings > Apple Accounts**, so Xcode can sign for the team.

### The bundle ID and its capability

The bundle ID names the app on Apple's side and on your board. Pick one in reverse-DNS form that no other team has registered, such as `com.<you>.stellaris`; `com.example.stellaris` in the checkout is a placeholder, which only the simulator takes. The test targets use the same ID with `.tests` and `.uitests` after it.

You don't register the bundle ID on developer.apple.com first. `project.yml` turns on automatic signing, and with it Xcode creates the App ID in your team, adds the capabilities the app's entitlements name, Associated Domains among them, and makes and downloads the provisioning profile, the first time it builds for your iPhone. If the Signing section reports instead that the profile lacks Associated Domains, enable it for the App ID under **Certificates, Identifiers & Profiles > Identifiers** on developer.apple.com, then build again.

### What the membership is for

A free Apple Account can run apps from Xcode on its own devices, with profiles that expire after 7 days, but it can't use the Associated Domains capability. The app's entitlements always name it, whichever way you'll sign in, so Xcode can't sign the app for a free account's personal team. The team that signs it must be in the Apple Developer Program.

## 3. Configure and generate the project

1. Copy the example beside it, which git ignores:

   ```bash
   cp apps/ios/Config/Local.xcconfig.example apps/ios/Config/Local.xcconfig
   ```

2. Set the three values in `apps/ios/Config/Local.xcconfig`:

   ```
   STELLARIS_BUNDLE_ID = com.<you>.stellaris
   STELLARIS_TEAM = <your team ID>
   STELLARIS_BOARD_HOST = <your board's host>
   ```

   - `STELLARIS_TEAM` is the 10-character team ID.
   - `STELLARIS_BOARD_HOST` is the host alone, such as `board.example.com`: no `https://`, no path, no port. In an `.xcconfig`, `//` starts a comment, so a value written as an address ends at `https:`. The app lists the host as `webcredentials:<host>` in its associated domains and offers GitHub sign-in only on that host. A board you'll only sign in to with a token can be any host, but the build must still name one.

   `Config/Stellaris.xcconfig` includes `Local.xcconfig` when it exists, so these replace its defaults in every build.

3. Generate the project:

   ```bash
   cd apps/ios
   xcodegen generate
   ```

   It writes `Stellaris.xcodeproj` and, in `Generated/`, the app's `Info.plist` and entitlements, none of which git tracks. Run it again after every pull, and after any change under `apps/ios`: the project lists the app's source files as they were when it was generated, so a file a pull adds is missing from the build until you do. A change to `Local.xcconfig` needs no new project, only a new build.

## 4. Connect the iPhone

1. Connect the iPhone to the Mac with a cable and unlock it. When it asks whether to trust this computer, tap **Trust** and enter its passcode.
2. In Xcode, choose **Manage Devices…** from the run destination menu in the toolbar, or **Xcode > Open Developer Tool > Device Hub**. If the iPhone shows a **Pair** button there, click it.
3. Turn on Developer Mode, which the iPhone offers only once it has been paired with a Mac: **Settings > Privacy & Security > Developer Mode**, under Security. Tap **Restart**, and once it has restarted, unlock it, tap **Enable**, and enter the passcode.

Once paired, the iPhone needs no cable: Xcode runs the app over Wi-Fi when the iPhone and the Mac are on the same network, with IPv6. On iOS 27 the first pairing can go over Wi-Fi too: in Device Hub, click **+** and choose **Pair Nearby Device**.

## 5. Build and run

1. Open the project: `open apps/ios/Stellaris.xcodeproj` from the checkout's root, or `open Stellaris.xcodeproj` in `apps/ios`.
2. In Xcode's toolbar, choose the **Stellaris** scheme and your iPhone as the run destination.
3. Select the **Stellaris** project in the navigator, then the **Stellaris** target, then **Signing & Capabilities**. **Automatically manage signing** is on, the team is the one `STELLARIS_TEAM` names, and the bundle identifier is your `STELLARIS_BUNDLE_ID`. The first build for the iPhone registers the bundle ID and makes the provisioning profile ([The bundle ID and its capability](#the-bundle-id-and-its-capability)). If it can't, the Signing section says why ([Troubleshooting](#troubleshooting)). Change the team or the bundle ID in `Local.xcconfig`, not here: the next `xcodegen generate` drops whatever this editor writes into the project.
4. Choose **Product > Run** (⌘R). Xcode builds the app, installs it on the iPhone, and opens it on the sign-in screen.

If the iPhone won't open the app and says its developer isn't trusted, trust your developer account on the iPhone: **Settings > General > VPN & Device Management**, tap your account under Developer App, then **Trust**, with the iPhone online. Then open the app again.

## 6. Sign in

Enter the board's address, `https://<host>` or the host alone, and tap **Continue**. The app asks the board how it lets people in and offers what it can.

### With a token

This works on any board the iPhone reaches over `https`. Paste the user token into **Token** and tap **Sign in with the token**. The app keeps the token in the iPhone's Keychain only once the board takes it.

The user token is the one `stellaris init` printed, or, on a board installed with the Helm chart without GitHub sign-in, the one its first start left in `/data/initial-user-token` ([the chart's first start](../../helm/stellaris/README.md#first-start)). A chart install with GitHub sign-in on leaves no such file. The board keeps only a hash of the token, so a lost one can't be shown again: `stellaris user token --rotate` issues a new one and stops the old one everywhere, the browsers that use it included, and a running server takes it only after a restart. With the chart, run it in the server's pod, as the chart's README does. `kubectl -n <namespace> get deploy` lists the server's deployment, `stellaris-server` for a release named `stellaris`:

```bash
kubectl -n <namespace> exec deploy/<server deployment> -c server -- stellaris user token --rotate
kubectl -n <namespace> rollout restart deploy/<server deployment>
```

### With GitHub

**Sign in with GitHub** shows only when the board has GitHub sign-in on, names this app, and is on the host the build names. The board's side:

1. GitHub sign-in is on: `STELLARIS_GITHUB_CLIENT_ID`, `STELLARIS_GITHUB_CLIENT_SECRET`, and `STELLARIS_GITHUB_USERS` are set ([Signing in](running-a-society.md#signing-in)), and the GitHub OAuth app's callback URL is on the host in `STELLARIS_BOARD_HOST`.
2. Set `STELLARIS_APPLE_APP_ID` to `<team ID>.<bundle ID>`, the two values from `Local.xcconfig` joined by a dot, such as `ABCDE12345.com.<you>.stellaris`. With the Helm chart, it is `auth.github.appleAppId`:

   ```yaml
   auth:
     github:
       appleAppId: ABCDE12345.com.<you>.stellaris
   ```

   The server reads it when it starts, so restart it after setting the variable. With the chart, upgrading the release with the new value restarts the server.

3. Check what the board serves, from any machine:

   ```bash
   curl -sS https://<host>/auth/config
   # {"github":true,"appLanding":true}
   curl -sS -i https://<host>/.well-known/apple-app-site-association
   # HTTP 200, with {"webcredentials":{"apps":["ABCDE12345.com.<you>.stellaris"]}}
   ```

   Apple reads the file only at that address, with no redirect, so an Ingress or a proxy in front of the board must pass `/.well-known/` to the server rather than redirect it.

4. Install the app once the board serves the file. The iPhone doesn't read the file from the board but from Apple's CDN, when the app is installed, and the CDN asks the board for it then if it holds no copy or an outdated one. Apple says the CDN requests the file within 24 hours, and an installed app checks for a newer one about once a week. So an app installed before the board served the file holds no association for days: delete it from the iPhone and run it again from Xcode. To see what the CDN holds:

   ```bash
   curl -sS https://app-site-association.cdn-apple.com/a/v1/<host>
   # the same JSON as the board's once the CDN holds the file, Not Found while it holds none
   ```

   Apple also gives builds run from Xcode a way past the CDN, the `developer` alternate mode: the associated domain becomes `webcredentials:<host>?mode=developer`, and an iPhone with **Associated Domains Development** on under **Settings > Developer** reads the file from the board itself. This build doesn't offer it: `project.yml` writes the domain from `STELLARIS_BOARD_HOST`, which the app also compares with the board's host, so a `?mode=developer` in that setting hides **Sign in with GitHub**.

Then, in the app, enter the board's address, tap **Sign in with GitHub**, tap **Continue** when iOS asks whether Stellaris may use the board's address to sign in, and sign in on GitHub. The app lands back on the board's sign-in landing and trades its one-time code for a session that lasts 30 days.

## Which board the app needs

A board tells its version without a token:

```bash
curl -sS https://<host>/health
# {"ok":true,"version":"0.3.27"}
```

Signing in with GitHub needs a board of 0.3.27 or later, the first release with the `https` sign-in landing. An older board answers `/auth/config` without `appLanding`, so the app offers the token alone.

Beyond that, the app reads the board's answers as the server at the app's own commit gives them: the server's test `apps/server/src/ios-fixtures.test.ts` captures every answer the app reads into `apps/ios/fixtures/api`. So an app built from a release's tag works with a board of that release. To check an app from a later commit against an older board, run the commit's capture test against the board's release, with the README's [prerequisites](../../README.md#prerequisites) for the server (Node and pnpm). Run it from the checkout's root. `HUSKY=0` keeps the install from setting the commit hook on your checkout, which the worktree shares:

```bash
git worktree add ../stellaris-board v<board version>
cp apps/server/src/ios-fixtures.test.ts ../stellaris-board/apps/server/src/
rm -rf ../stellaris-board/apps/ios/fixtures/api
cp -R apps/ios/fixtures/api ../stellaris-board/apps/ios/fixtures/api
(cd ../stellaris-board && HUSKY=0 pnpm install --frozen-lockfile && pnpm build &&
  CI=1 pnpm vitest run apps/server/src/ios-fixtures.test.ts)
git worktree remove --force ../stellaris-board
```

A pass means the release gives the app every answer it reads, as its own commit's server does. A failing test names the answer that differs. A failure at `pnpm build` instead, a type error in `ios-fixtures.test.ts` such as `TS2353 … 'signIn' does not exist in type 'TestSocietyOptions'` against 0.3.26, means the test needs something of the server's test harness that the release lacks, so it can't tell. Either way, build the app from the release's tag, or update the board.

## What to try on the device

The app's tests run in CI on the iPhone Duo simulator, which boots closed, doesn't rotate, and runs no VoiceOver. These are what only a device shows. The ones about the inner display, folding and the poses need a phone that folds, or Device Hub's iPhone Duo simulator, which shows both displays and every pose.

**Signing in and the system's own screens**

- GitHub sign-in end to end, and a token.
- Two cancels say nothing: **Cancel** at iOS's prompt asking whether Stellaris may use the board's address to sign in, and closing GitHub's sheet. Either one showing "iOS ended the sign-in: …" would mean iOS gives a person's cancel a reason too.
- A sign-in iOS refuses shows iOS's reason. To bring a refusal back once the iPhone holds the association, build once with a `STELLARIS_BUNDLE_ID` the board's file doesn't name (automatic signing registers its App ID), run it, and tap **Sign in with GitHub**: the app should say "iOS ended the sign-in: …" in red. Then delete that build from the iPhone and set the bundle ID back.
- On the inner display folded like a book, the sign-in form keeps off the fold, on the wider side.
- The launch screen, which no test or picture covers.
- Whether iOS's GitHub sign-in sheet is dark: iOS draws it, not the app, so it may not follow the app's setting.

**Touch and the keyboard on the outer display**

- A link or an image in the top-leading part of Chat opens. On the simulator, a tap inside the status bar's frame there, 223 by 317 points from the window's corner, reaches no message and scrolls the conversation to its top instead.
- At the largest text size (Settings > Accessibility > Display & Text Size > Larger Text), the plan's half-height sheet closes with a drag down on its bar, at its middle or its foot. In CI, only a drag on its content closed it.
- The keyboard covers the side bar, its tabs included, until a scroll puts it away.
- The image viewer's ✕ over the top-right corner of a full-width image.

**Turning and folding**

- Turning the phone: the tab bar runs along the foot in portrait. In landscape, note whether the tabs beside the sky get the vertical bar, and whether it shows their titles.
- Unfolding brings the sky in with a fade, beside the chat in landscape and above it in portrait; folding takes it away. The chat stays where it was through both, with its draft and its scroll.
- A partial fold, as when the phone stands half open on a table, moves nothing.
- On a tabletop fold, whether the card below the fold, and Advance and Approve at the bar's trailing end, are easy to reach.
- The fold's band: the sky's camera keeps it clear, and a card a tap opens stays clear of it and of the inner display's camera. The tests assume a band 21 points wide at the middle, and no camera.
- In portrait on the inner display: whether the card a star opens covers the sphere it describes, and whether the whole sky shows the top of the first project's orbit.
- A pan of the sky near an edge, against the system's edge swipes.
- The plan opens beside the thread in portrait, and in a sheet in landscape and on the outer display.
- Split View at its narrowest on the inner display shows the chat alone.
- The composer and the keyboard in each pose, and whether the keyboard stays up and the composer keeps its place through a fold, a turn or an unfold.
- New thread's sheet moves off the fold, and where its Cancel and Open thread sit on the open phone. In a test window wider than the outer display, iOS draws them mid-sheet, so CI can't show it.
- The New thread, Advance, and Reject sheets keep their text through a fold, an unfold, and a turn, and the plan stays open.

**Text**

- A New thread title pasted past 200 characters. The cap lives in the model, behind a binding, and is tested only there; a field that shows more than 200 opens a thread with the first 200.
- A task's strip at 320 points wide and the largest text size: how tall it stands.

**VoiceOver**

- The sky's elements: each sphere, star, and mark, each with Zoom in and Zoom out, and the camera's own element, whose value describes the camera and which takes it back to the whole sky when activated.
- With the keyboard up on the inner display, the chat covers the sky, and VoiceOver skips the sky.
- Links, images, and task lists in messages. An image is read by its alt text.
- The two-finger scrub closes the plan's, the charter's, and Settings' sheets.
- A task's or a proposal's strip at the accessibility text sizes is read in full.

**Over time**

- The sky draws smoothly, and the battery holds up with it on screen.

## Troubleshooting

**Xcode and signing**

Automatic signing fixes most signing errors by itself. When the Signing section of **Signing & Capabilities** still shows one, it says what is missing:

- **No team.** `Local.xcconfig` isn't at `apps/ios/Config/Local.xcconfig`, or `STELLARIS_TEAM` is empty or mistyped. Fix the file and build again.
- **No account for the team.** Add the Apple Account under **Xcode > Settings > Apple Accounts**.
- **The bundle ID isn't available.** Another team has registered it. Choose another `STELLARIS_BUNDLE_ID`, and set the board's `STELLARIS_APPLE_APP_ID` to match.
- **The team doesn't support Associated Domains.** It is a free account's personal team ([What the membership is for](#what-the-membership-is-for)).
- **The profile lacks Associated Domains.** Enable it for the App ID on developer.apple.com ([The bundle ID and its capability](#the-bundle-id-and-its-capability)).

**The build**

- **"Cannot find '…' in scope" after a pull.** The project predates a file the pull added, since it lists the source files as they were when it was generated. Run `xcodegen generate` in `apps/ios` again ([Configure and generate the project](#3-configure-and-generate-the-project)).

**The iPhone**

- **The iPhone isn't among the run destinations.** It isn't paired, or Developer Mode is off ([Connect the iPhone](#4-connect-the-iphone)). An iPhone pairs again after every update of its iOS. An iPhone on iOS older than 27.0 shows, but can't run the app, whose deployment target is 27.0.
- **Xcode can't build for the iPhone, and its run destination offers Get.** The iOS platform isn't installed: click **Get**, or install it under **Xcode > Settings > Components**.
- **The developer isn't trusted.** Trust it under **Settings > General > VPN & Device Management** ([Build and run](#5-build-and-run)).

**The app**

- **"The board's address must start with https://."** The app takes `https` only, since every request carries the token. A board on plain `http` or on a certificate the iPhone doesn't trust can't be signed in to.
- **"Can't reach the board."** The iPhone gets no answer at the address, or an answer it can't read. Open the address in Safari on the iPhone. If the board answers there and one view still says it once signed in, the board may be too old ([Which board the app needs](#which-board-the-app-needs)).
- **"The board doesn't take this token."** The token is mistyped, or it was rotated.
- **"The board ended this sign-in."** The board stopped taking the token: a GitHub sign-in ends after 30 days or when you sign out, and the user token when it is rotated. Sign in again.
- **No Sign in with GitHub.** One of three things is missing. `curl https://<host>/auth/config` must answer `{"github":true,"appLanding":true}`: `github` false means GitHub sign-in is off, and `appLanding` false means `STELLARIS_APPLE_APP_ID` isn't set or the server hasn't restarted since, or the board is older than 0.3.27. If both are true, the address you entered isn't on the host in `STELLARIS_BOARD_HOST`: change one of them, then build again.
- **"Signing in to the app is off on this board" (a 403)** in the sign-in sheet. The board's `STELLARIS_APPLE_APP_ID` was unset after the app read its configuration. Set it, restart the server, and tap **Change** and **Continue** in the app to read the configuration again.
- **The board doesn't start after `STELLARIS_APPLE_APP_ID` is set.** The value isn't `<team ID>.<bundle ID>`: a 10-character team ID of capitals and digits, a dot, then the bundle ID. The server refuses it at start, and the chart refuses `auth.github.appleAppId` when it renders.
- **A 404 at `/.well-known/apple-app-site-association`.** The board names no app: `STELLARIS_APPLE_APP_ID` is unset, or the server hasn't restarted since. If the server answers it on its own address but not on the public one, the proxy in front of it doesn't send `/.well-known/` to the server.
- **"iOS ended the sign-in: Application with identifier … is not associated with domain …"**, or, in a build from before the app showed it, nothing at all when you tap **Sign in with GitHub**. iOS refused the sign-in before showing GitHub, since the iPhone holds no association between this build and the board's host. The iPhone fetches the association file when the app is installed and checks again about once a week, so an app installed before the board served the file keeps refusing: delete it and run it again from Xcode. If that doesn't help, check that the team and bundle ID in **Signing & Capabilities** are the two halves of the ID in the board's file, and that Associated Domains lists `webcredentials:<host>`.
- **The sign-in sheet stays on the board's page, or the app says "GitHub's sign-in ended somewhere the app doesn't know."** iOS didn't hand the landing to the app, since it doesn't hold the board's association for this app yet. Check that the ID in the board's file is exactly `<team ID>.<bundle ID>` of this build and what the CDN holds, as in [With GitHub](#with-github), then delete the app and run it again from Xcode, so the install fetches the file.
- **"This GitHub account isn't one the board lets in."** Add the login, or its numeric id, to `STELLARIS_GITHUB_USERS` (the chart's `auth.github.users`).
- **"The sign-in took too long to finish."** The one-time code expired before the app traded it. Try again.
