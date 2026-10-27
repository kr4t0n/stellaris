#!/usr/bin/env bash
# Follows the output of the app's UI tests, and when a copy of the app still runs 10 s after XCTest
# began ending it, which takes 1 to 2 s, keeps what that copy and the simulator's processes that end
# it were doing while it still runs: its state, its stacks with the kernel's, the simulator's jobs,
# and the simulator's log of those processes. It reads the simulator's processes alone, never the
# Mac's, since what it keeps becomes an artifact anyone signed in to GitHub can download.
# Usage: catch-stuck-app.sh <bundle id> <test output> <folder>. It stops once <test output>.done
# exists, after the captures under way.
set -uo pipefail

bundle=$1
output=$2
folder=$3
mkdir -p "$folder"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The simulator the app runs in, from the path of its executable, or else the one booted.
device_of() {
  local device
  device=$(ps -o command= -p "$1" 2>/dev/null |
    sed -nE 's|.*/CoreSimulator/Devices/([0-9A-F-]{36})/.*|\1|p')
  if [ -z "$device" ]; then
    device=$(xcrun simctl list devices booted |
      sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -1)
  fi
  echo "$device"
}

# The pid of the simulator's job whose label matches, from launchd inside the simulator.
job_pid() {
  awk -v label="$2" '$3 ~ label && $1 ~ /^[0-9]+$/ { print $1; exit }' "$1"
}

simulator_log() {
  local device=$1 dir=$2
  xcrun simctl spawn "$device" log show --last 6m --info --style compact --predicate \
    'process == "Stellaris" OR process == "StellarisUITests-Runner" OR process == "testmanagerd" OR process == "runningboardd" OR process == "SpringBoard" OR subsystem == "com.apple.runningboard"' \
    >"$dir/simulator.log" 2>&1
}

capture() {
  local pid=$1 dir="$folder/$1" waited=0 device jobs proc
  while ps -p "$pid" >/dev/null 2>&1 && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if ! ps -p "$pid" >/dev/null 2>&1; then
    return 0
  fi
  mkdir -p "$dir"
  device=$(device_of "$pid")
  {
    echo "$(now) $bundle:$pid still runs $waited s after XCTest began ending it, in simulator ${device:-unknown}"
    ps -o pid,ppid,stat,etime,time,%cpu,rss,command -p "$pid"
    ps -o wchan -p "$pid"
  } >>"$dir/summary.txt" 2>&1
  if [ -z "$device" ]; then
    return 0
  fi
  jobs="$dir/simulator-jobs.txt"
  xcrun simctl spawn "$device" launchctl list >"$dir/all-jobs.txt" 2>&1
  awk 'NR == 1 || /stellaris|testmanagerd|runningboardd|SpringBoard/' "$dir/all-jobs.txt" >"$jobs"
  rm -f "$dir/all-jobs.txt"
  sample "$pid" 3 -file "$dir/sample.txt" >/dev/null 2>"$dir/sample.err"
  # spindump samples every process on the machine unless told to sample only these.
  local others=()
  for label in 'com\.apple\.testmanagerd' 'com\.apple\.runningboardd' 'com\.apple\.SpringBoard' \
    "${bundle//./\\.}\\.uitests\\.xctrunner"; do
    proc=$(job_pid "$jobs" "$label")
    if [ -n "$proc" ]; then
      others+=(-proc "$proc")
    fi
  done
  sudo -n spindump "$pid" 5 10 -onlyTarget ${others[@]+"${others[@]}"} -noBinary -timelimit 90 \
    -o "$dir/spindump.txt" >/dev/null 2>"$dir/spindump.err" ||
    sudo -n spindump "$pid" 5 10 -onlyTarget -noBinary -timelimit 90 \
      -o "$dir/spindump-app.txt" >/dev/null 2>>"$dir/spindump.err"
  sudo -n chown -R "$(id -u)" "$dir" 2>/dev/null
  # How long it outlives XCTest's attempt, and in what state.
  waited=0
  while ps -p "$pid" >/dev/null 2>&1 && [ "$waited" -lt 180 ]; do
    ps -o stat=,%cpu=,etime= -p "$pid" | sed "s/^/$(now) /" >>"$dir/summary.txt"
    sleep 5
    waited=$((waited + 5))
  done
  if ps -p "$pid" >/dev/null 2>&1; then
    echo "$(now) still running" >>"$dir/summary.txt"
  else
    echo "$(now) gone" >>"$dir/summary.txt"
  fi
  simulator_log "$device" "$dir"
}

# When XCTest gives up on a copy that ended before it was captured, the simulator's log alone.
gave_up() {
  local pid=$1 dir="$folder/$1-gave-up" device
  sleep 15
  if [ -e "$folder/$pid" ]; then
    return 0
  fi
  mkdir -p "$dir"
  echo "$(now) XCTest failed to end $bundle:$pid, which was gone" >"$dir/summary.txt"
  device=$(device_of "$pid")
  if [ -n "$device" ]; then
    simulator_log "$device" "$dir"
  fi
}

ending="Terminate ${bundle//./\\.}:[0-9]+"
failed="Failed to terminate ${bundle//./\\.}:[0-9]+"
seen=" "
missed=" "
while [ ! -e "$output.done" ]; do
  while read -r pid; do
    case "$seen" in
      *" $pid "*) ;;
      *)
        seen="$seen$pid "
        capture "$pid" &
        ;;
    esac
  done < <(grep -oE "$ending" "$output" 2>/dev/null | sed 's/.*://')
  while read -r pid; do
    case "$missed" in
      *" $pid "*) ;;
      *)
        missed="$missed$pid "
        gave_up "$pid" &
        ;;
    esac
  done < <(grep -oE "$failed" "$output" 2>/dev/null | sed 's/.*://' | grep -v '^0$')
  sleep 1
done
wait
