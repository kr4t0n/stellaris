#!/usr/bin/env bash
# Installs the packed npm packages in a scratch prefix and uses them as a user would: the CLI
# creates a society and registers a runner, the server serves the interface, and the runner
# connects to it. Usage: smoke.sh <directory holding the .tgz files>
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
user_token=$(stellaris --json init --name smoke | json userToken)
runner_token=$(stellaris --json runner add smoke | json token)

port=$((40000 + RANDOM % 20000))
url="http://127.0.0.1:$port"
STELLARIS_PORT=$port stellaris-server > "$work/server.log" 2>&1 &
for _ in $(seq 1 100); do curl -fs "$url/health" > /dev/null && break; sleep 0.2; done
curl -fs "$url/health" > /dev/null || { cat "$work/server.log"; exit 1; }
curl -fs "$url/" | grep -q "<title>Stellaris</title>" || { echo "the server does not serve the interface"; exit 1; }

STELLARIS_SERVER_URL=$url STELLARIS_RUNNER_TOKEN=$runner_token STELLARIS_RUNNER_DIR="$work/runner" \
  stellaris-runner > "$work/runner.log" 2>&1 &
for _ in $(seq 1 100); do
  curl -fs -H "Authorization: Bearer $user_token" "$url/api/runners" | grep -q '"status":"connected"' && break
  sleep 0.2
done
curl -fs -H "Authorization: Bearer $user_token" "$url/api/runners" | grep -q '"status":"connected"' ||
  { echo "the runner did not connect"; cat "$work/runner.log"; exit 1; }
echo "smoke passed: a society, the server with its interface, and a connected runner"
