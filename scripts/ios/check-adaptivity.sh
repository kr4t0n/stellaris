#!/usr/bin/env bash
# Refuses Swift in the iOS app that lays itself out by the screen, the kind of device, or the
# orientation, all of which iPhone Duo breaks: the app's window isn't the screen, and either display
# shows it either way round. A view reads its size classes and its own size instead. Before reading
# the app, it checks that it catches a planted line of each kind it refuses.
# Usage: check-adaptivity.sh [folder...], by default the app's sources and BoardKit's.
set -euo pipefail

pattern='UIScreen\.main|userInterfaceIdiom|UIUserInterfaceIdiom|UIDeviceOrientation|UIInterfaceOrientation|interfaceOrientation|orientationDidChangeNotification|\.orientation([^A-Za-z0-9_]|$)'

planted=(
  'let width = UIScreen.main.bounds.width'
  'if UIDevice.current.userInterfaceIdiom == .pad {}'
  'let idiom: UIUserInterfaceIdiom = .phone'
  'let wide = UIDevice.current.orientation.isLandscape'
  'let turned: UIDeviceOrientation = .portrait'
  'let side = scene.interfaceOrientation'
  'let allowed: UIInterfaceOrientationMask = .all'
  'let name = UIDevice.orientationDidChangeNotification'
)
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
printf '%s\n' "${planted[@]}" 'let size = proxy.size' 'let regular = sizeClass == .regular' \
  >"$probe/Planted.swift"
caught=$(grep -rnE --include='*.swift' "$pattern" "$probe" | wc -l | tr -d ' ')
if [ "$caught" != "${#planted[@]}" ]; then
  echo "check-adaptivity.sh caught $caught lines of the ${#planted[@]} planted" >&2
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
