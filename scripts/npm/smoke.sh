#!/usr/bin/env bash
# Installs the packed npm packages in a scratch prefix and uses them as a user would: the CLI
# creates a society, the server serves the interface, a runner enrolls and is approved through the
# API, connects, and connects again after a restart with what it saved. Usage: smoke.sh <directory
# holding the .tgz files>
set -euo pipefail

tarballs=$(cd "$1" && pwd)
work=$(mktemp -d)
cleanup() {
  kill $(jobs -p) 2> /dev/null || true
  wait 2> /dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

npm install --global --prefix "$work/prefix" --no-audit --no-fund "$tarballs"/*.tgz > /dev/null
export PATH="$work/prefix/bin:$PATH" STELLARIS_DATA_DIR="$work/data"
echo "stellaris $(stellaris --version), stellaris-server $(stellaris-server --version), stellaris-runner $(stellaris-runner --version)"

json() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]]))' "$1"; }
stellaris --json init --name smoke > /dev/null
user_token=$(stellaris --json user token --rotate | json userToken)

port=$((40000 + RANDOM % 20000))
url="http://127.0.0.1:$port"
STELLARIS_PORT=$port stellaris-server > "$work/server.log" 2>&1 &
for _ in $(seq 1 100); do curl -fs "$url/health" > /dev/null && break; sleep 0.2; done
curl -fs "$url/health" > /dev/null || { cat "$work/server.log"; exit 1; }
curl -fs "$url/" | grep -q "<title>Stellaris</title>" || { echo "the server does not serve the interface"; exit 1; }

api() { curl -fs -H "Authorization: Bearer $user_token" -H "content-type: application/json" "$@"; }
runner() {
  STELLARIS_SERVER_URL=$url STELLARIS_RUNNER_DIR="$work/runner" stellaris-runner > "$work/$1" 2>&1 &
}

runner runner.log
first=$!
code=""
for _ in $(seq 1 100); do
  code=$(api "$url/api/enrollments" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8"))[0]?.userCode ?? "")')
  [ -n "$code" ] && break
  sleep 0.2
done
[ -n "$code" ] || { echo "the runner did not ask to enroll"; cat "$work/runner.log"; exit 1; }
api -X POST -d '{"name":"smoke"}' "$url/api/enrollments/$code/approve" > /dev/null
for _ in $(seq 1 100); do
  curl -fs -H "Authorization: Bearer $user_token" "$url/api/runners" | grep -q '"status":"connected"' && break
  sleep 0.2
done
curl -fs -H "Authorization: Bearer $user_token" "$url/api/runners" | grep -q '"status":"connected"' ||
  { echo "the runner did not connect"; cat "$work/runner.log"; exit 1; }
[ "$(stat -c %a "$work/runner/credentials.json")" = 600 ] || { echo "the runner's credentials are readable by others"; exit 1; }

kill "$first"
wait "$first" || true
runner runner-again.log
for _ in $(seq 1 100); do grep -q '"msg":"runner connected"' "$work/runner-again.log" && break; sleep 0.2; done
grep -q '"msg":"runner connected"' "$work/runner-again.log" ||
  { echo "the runner did not connect again with its saved token"; cat "$work/runner-again.log"; exit 1; }
[ "$(api "$url/api/enrollments")" = "[]" ] || { echo "the restarted runner asked to enroll again"; exit 1; }
echo "smoke passed: a society, the server with its interface, and a runner enrolled, connected, and back"
