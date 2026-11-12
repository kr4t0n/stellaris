#!/usr/bin/env bash
# Refuses Swift in the iOS app that lays itself out by the screen, the kind of device, or the
# orientation, all of which iPhone Duo breaks: the app's window isn't the screen, and either display
# shows it either way round. A view reads its size classes and its own size instead. Before reading
# the app, it checks that it catches a planted line of each kind it refuses, and, as a check of its
# own, that it passes every line it must, such as a blend mode's `.screen`.
# A screen read is a `.screen` after a name, a call, an optional, a subscript, or a key path's `\`,
# or at a line's start followed by `.` or `?`. A line that starts with `.screen` followed by
# neither, as a chain broken on both sides of it leaves one, passes, since a blend mode's case reads
# the same; and `BlendMode.screen` written whole is refused, so write the case as `.screen` where
# its type is known.
# Usage: check-adaptivity.sh [folder...], by default the app's sources and BoardKit's.
set -euo pipefail

pattern='UIScreen([^A-Za-z0-9_]|$)|([]A-Za-z0-9_?!)]|\\)\.screen([^A-Za-z0-9_]|$)|^[[:space:]]*\.screen[.?]|userInterfaceIdiom|UIUserInterfaceIdiom|UIDevice\.current\.(model|localizedModel)|UIDeviceOrientation|UIInterfaceOrientation|interfaceOrientation|statusBarOrientation|orientationDidChangeNotification|\.orientation([^A-Za-z0-9_]|$)'

planted=(
  'let width = UIScreen.main.bounds.width'
  'let first = UIScreen.screens.first'
  'let width = view.window?.windowScene?.screen.bounds.width'
  'let screen = scene.screen'
  'guard let screen = view.window?.windowScene?.screen else { return }'
  'let s = scene.screen, other = 1'
  'print(scene.screen)'
  'let width = UIApplication.shared.windows[0].screen.bounds.width'
  'let screens = scenes.map(\.screen)'
  '  .screen.bounds.width'
  '  .screen?.bounds.width'
  'if UIDevice.current.userInterfaceIdiom == .pad {}'
  'let idiom: UIUserInterfaceIdiom = .phone'
  'if UIDevice.current.model == "iPad" {}'
  'let wide = UIDevice.current.orientation.isLandscape'
  'let turned: UIDeviceOrientation = .portrait'
  'let side = scene.interfaceOrientation'
  'let allowed: UIInterfaceOrientationMask = .all'
  'let bar = UIApplication.shared.statusBarOrientation'
  'let name = UIDevice.orientationDidChangeNotification'
)
passing=(
  'let size = proxy.size'
  'let regular = sizeClass == .regular'
  'Text("Lit").blendMode(.screen)'
  'let mode: BlendMode = .screen'
  'let modes: [BlendMode] = [.multiply, .screen]'
  '  .screen'
  'let shot = scene.screenshotService'
)
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
printf '%s\n' "${planted[@]}" >"$probe/Planted.swift"
printf '%s\n' "${passing[@]}" >"$probe/Passing.swift"
# grep selects nothing with 1 and fails with 2, which stops the check.
missed=$(grep -vE "$pattern" "$probe/Planted.swift") || [ $? -eq 1 ]
if [ -n "$missed" ]; then
  printf '%s\n' "$missed" >&2
  echo "check-adaptivity.sh missed these planted lines" >&2
  exit 2
fi
flagged=$(grep -E "$pattern" "$probe/Passing.swift") || [ $? -eq 1 ]
if [ -n "$flagged" ]; then
  printf '%s\n' "$flagged" >&2
  echo "check-adaptivity.sh refused these lines it must let through" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
if [ "$#" -eq 0 ]; then
  set -- "$root/apps/ios/Stellaris" "$root/apps/ios/BoardKit/Sources"
fi
for folder in "$@"; do
  if [ ! -d "$folder" ]; then
    echo "check-adaptivity.sh: no folder $folder" >&2
    exit 2
  fi
done
if found=$(grep -rnE --include='*.swift' "$pattern" "$@"); then
  printf '%s\n' "$found" >&2
  echo "Lay the app out by its size classes and its own size, not by the screen, the device, or the orientation (docs/internals/ios.md)." >&2
  exit 1
fi
