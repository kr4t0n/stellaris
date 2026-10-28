#!/usr/bin/env bash
# Follows the output of the app's UI tests, and when a copy of the app is still there 10 s after
# XCTest began ending it, which takes 1 to 3 s, keeps what that copy and the simulator's processes
# that end it were doing while it is still there: its state, its open terminals, its stacks with the
# kernel's, the simulator's jobs, and the simulator's log of those processes, with the stacks of
# xcodebuild, which reads the app's console. For the first copies it sees launch, it also keeps
# where their console goes, as last recorded while they run: their open devices, who holds those
# terminals, and their logging variables. It fails when a copy launched against the fake board still
# has a terminal for its output then, since its writes there wait on xcodebuild
# (docs/internals/ios.md). It keeps nothing else of the Mac's, no log and no environment beyond
# those variables, since what it keeps becomes an artifact anyone signed in to GitHub can download.
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

# Whether a copy is still there: in the Mac's process table, or still a job of the simulator's
# launchd, which reaps it. A copy XCTest couldn't end has left the first long before the second
# reaped it.
alive() {
  if ps -p "$1" >/dev/null 2>&1; then
    return 0
  fi
  [ -n "$2" ] && xcrun simctl spawn "$2" launchctl list 2>/dev/null |
    awk -v pid="$1" '$1 == pid { found = 1 } END { exit !found }'
}

# A copy's line in the Mac's process table and in the simulator's launchd, if it has them.
state() {
  echo "$(now) ps: $(ps -A -o pid=,stat=,%cpu=,etime= | awk -v pid="$1" '$1 == pid')" \
    "launchd: $(xcrun simctl spawn "$2" launchctl list 2>/dev/null | awk -v pid="$1" '$1 == pid')"
}

# The pid of the simulator's job whose label matches, from launchd inside the simulator.
job_pid() {
  awk -v label="$2" '$3 ~ label && $1 ~ /^[0-9]+$/ { print $1; exit }' "$1"
}

# A process's open character devices: terminals, /dev/null, and the like.
devices() {
  lsof -n -P -a -p "$1" -d 0-255 2>&1 | awk 'NR == 1 || $5 == "CHR"'
}

# Where a copy's console goes: its devices, who holds each terminal among them, and its logging
# variables, by an allowlist of names, since its environment holds more than they do.
record() {
  local pid=$1 tty
  echo "$(now) $bundle:$pid"
  devices "$pid"
  for tty in $(devices "$pid" | awk '$NF ~ /^\/dev\/ttys[0-9]+$/ { print $NF }' | sort -u); do
    echo "holders of $tty:"
    lsof -n -P "$tty" 2>&1 | awk '{ print $1, $2, $4, $5, $9 }'
  done
  echo "xcodebuild's terminals:"
  for proc in $(pgrep -x xcodebuild); do
    devices "$proc" | awk '/ptmx|ttys/'
  done
  if ps -wwE -o command= -p "$pid" | tr ' ' '\n' | grep -q '^STELLARIS_FAKE_BOARD='; then
    echo "fake board: yes"
  else
    echo "fake board: no"
  fi
  echo "logging variables:"
  ps -wwE -o command= -p "$pid" | tr ' ' '\n' |
    grep -E '^(OS_ACTIVITY_[A-Z_]*|OS_LOG_[A-Z_]*|IDE_[A-Za-z_]*|CFLOG_[A-Z_]*|NSUnbufferedIO)=' |
    cut -c1-80
}

# Records a copy's console every 10 s while it runs, keeping the last record that found its devices,
# from when XCTest's output first shows the app idle after the copy appeared: a copy still starting
# up hasn't yet pointed its console where the app sends it, and a first launch on a busy runner has
# taken 15 s, longer than the records once kept of it while it ran.
console() {
  local pid=$1 file="$folder/console/$1.txt" from
  mkdir -p "$folder/console"
  from=$(wc -l <"$output" 2>/dev/null || echo 0)
  until tail -n +"$((from + 1))" "$output" 2>/dev/null | grep -q "Wait for ${bundle//./\\.} to idle"; do
    if ! ps -p "$pid" >/dev/null 2>&1 || [ -e "$output.done" ]; then
      return 0
    fi
    sleep 1
  done
  while ps -p "$pid" >/dev/null 2>&1 && [ ! -e "$output.done" ]; do
    record "$pid" >"$file.new" 2>&1
    if grep -q '^Stellaris ' "$file.new"; then
      mv "$file.new" "$file"
    fi
    sleep 10
  done
  rm -f "$file.new"
}

simulator_log() {
  local device=$1 dir=$2
  xcrun simctl spawn "$device" log show --last 6m --info --style compact --predicate \
    'process == "Stellaris" OR process == "StellarisUITests-Runner" OR process == "testmanagerd" OR process == "runningboardd" OR process == "SpringBoard" OR subsystem == "com.apple.runningboard"' \
    >"$dir/simulator.log" 2>&1
}

capture() {
  local pid=$1 dir="$folder/$1" waited=0 device jobs proc
  device=$(device_of "$pid")
  while alive "$pid" "$device" && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if ! alive "$pid" "$device"; then
    return 0
  fi
  mkdir -p "$dir"
  {
    echo "$(now) $bundle:$pid still there $waited s after XCTest began ending it, in simulator ${device:-unknown}"
    ps -A -o pid,ppid,stat,etime,time,%cpu,rss,command | awk -v pid="$pid" 'NR == 1 || $1 == pid'
    ps -o wchan -p "$pid"
    devices "$pid"
    state "$pid" "$device"
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
  for proc in $(pgrep -x xcodebuild); do
    others+=(-proc "$proc")
  done
  sudo -n spindump "$pid" 5 10 -onlyTarget ${others[@]+"${others[@]}"} -noBinary -timelimit 90 \
    -o "$dir/spindump.txt" >/dev/null 2>"$dir/spindump.err" ||
    sudo -n spindump "$pid" 5 10 -onlyTarget -noBinary -timelimit 90 \
      -o "$dir/spindump-app.txt" >/dev/null 2>>"$dir/spindump.err"
  sudo -n chown -R "$(id -u)" "$dir" 2>/dev/null
  # How long it outlives XCTest's attempt, and in what state.
  waited=0
  while alive "$pid" "$device" && [ "$waited" -lt 180 ]; do
    state "$pid" "$device" >>"$dir/summary.txt" 2>&1
    sleep 5
    waited=$((waited + 5))
  done
  if alive "$pid" "$device"; then
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
launched=" "
while [ ! -e "$output.done" ]; do
  # The app's process is named after its executable, Stellaris.
  for pid in $(pgrep -x Stellaris); do
    case "$launched" in
      *" $pid "*) ;;
      *)
        launched="$launched$pid "
        if [ "$(echo "$launched" | wc -w)" -le 4 ]; then
          console "$pid" &
        fi
        ;;
    esac
  done
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
ends=$(echo "$seen" | wc -w | tr -d ' ')
kept=$(find "$folder" -mindepth 1 -maxdepth 1 -type d ! -name console | wc -l | tr -d ' ')
echo "catch-stuck-app.sh: followed $ends ends of $bundle, kept $kept captures"
loud=""
for file in "$folder"/console/*.txt; do
  if [ -e "$file" ] && grep -q '^fake board: yes' "$file" &&
    grep -qE '^Stellaris +[0-9]+ +[^ ]+ +[12][a-z]* +CHR .*/dev/ttys[0-9]+$' "$file"; then
    loud="$loud ${file##*/}"
  fi
done
if [ -n "$loud" ]; then
  echo "catch-stuck-app.sh: launched against the fake board, these copies write to a terminal:$loud" >&2
  exit 1
fi
