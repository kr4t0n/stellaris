#!/usr/bin/env bash
# Runs the built images as a deployment would, with nothing from the checkout mounted: the server
# image creates a society on a fresh volume, starts with its own command, passes its own health
# check, and serves the interface and the API; the runner image runs as its own user with the CLIs
# on its PATH, and its own command enrolls with that server, is approved through the API, and
# connects. Run from the repository root, which it reads only for the version both must report.
# Usage: smoke.sh <server image> <runner image>
set -euo pipefail

server_image=$1
runner_image=$2
version=$(sed -n 's/^export const STELLARIS_VERSION = "\(.*\)";$/\1/p' packages/shared/src/version.ts)
[ -n "$version" ] || { echo "no STELLARIS_VERSION in packages/shared/src/version.ts"; exit 1; }

run="stellaris-smoke-$$"
server="$run-server"
runner="$run-runner"
cleanup() {
  docker rm --force "$server" "$runner" > /dev/null 2>&1 || true
  docker volume rm "$run-data" > /dev/null 2>&1 || true
  docker network rm "$run" > /dev/null 2>&1 || true
}
trap cleanup EXIT
logs() {
  echo "--- $1"
  docker logs "$1" 2>&1 | tail -n 50
}
same() {
  [ "$2" = "$3" ] || { echo "$1: expected $3, got $2"; exit 1; }
}
json() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]]))' "$1"; }

same "the server image's admin CLI version" "$(docker run --rm "$server_image" stellaris --version)" "$version"
same "the server image's server version" \
  "$(docker run --rm "$server_image" node /app/server/dist/index.js --version)" "$version"
same "the runner image's runner version" "$(docker run --rm "$runner_image" stellaris-runner --version)" "$version"
# The account the chart's securityContext and the README's volume steps assume, and the CLIs, git,
# and kubectl that turns shell out to, on the PATH the image sets. kubectl's --client keeps it from
# looking for a cluster.
same "the runner image's account" \
  "$(docker run --rm "$runner_image" sh -c 'echo "$(id -un) $(id -u):$(id -g) $HOME"')" \
  "stellaris 1000:100 /home/stellaris"
docker run --rm "$runner_image" sh -c 'claude --version && codex --version && git --version && kubectl version --client'

docker network create "$run" > /dev/null
docker volume create "$run-data" > /dev/null
user_token=$(docker run --rm -v "$run-data:/data" "$server_image" stellaris --json init --name smoke | json userToken)
# The image's own health check, polled every 2 s instead of every 30 s.
docker run --detach --name "$server" --network "$run" -v "$run-data:/data" -p 127.0.0.1::4700 \
  --health-interval 2s --health-start-period 0s "$server_image" > /dev/null
url="http://$(docker port "$server" 4700/tcp | head -n 1)"
for _ in $(seq 1 100); do curl -fs "$url/health" > /dev/null && break; sleep 0.2; done
curl -fs "$url/health" > /dev/null || { logs "$server"; exit 1; }
curl -fs "$url/" | grep -q "<title>Stellaris</title>" || { echo "the server does not serve the interface"; exit 1; }

api() { curl -fs -H "Authorization: Bearer $user_token" -H "content-type: application/json" "$@"; }
docker run --detach --name "$runner" --network "$run" -e "STELLARIS_SERVER_URL=http://$server:4700" \
  "$runner_image" > /dev/null
code=""
for _ in $(seq 1 150); do
  code=$(api "$url/api/enrollments" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8"))[0]?.userCode ?? "")')
  [ -n "$code" ] && break
  sleep 0.2
done
[ -n "$code" ] || { echo "the runner did not ask to enroll"; logs "$runner"; exit 1; }
api -X POST -d '{"name":"smoke"}' "$url/api/enrollments/$code/approve" > /dev/null
connected() {
  api "$url/api/runners" | node -e '
    const runners = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(runners.some((r) => r.status === "connected" && r.version === process.argv[1]) ? 0 : 1);
  ' "$version"
}
for _ in $(seq 1 150); do connected && break; sleep 0.2; done
connected || { echo "the runner did not connect at version $version"; logs "$runner"; exit 1; }

health=""
for _ in $(seq 1 30); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$server")
  [ "$health" = healthy ] && break
  sleep 1
done
same "the server's health check" "$health" healthy
echo "smoke passed: the server $version with its interface and health check, and the runner $version enrolled and connected"
