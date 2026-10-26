#!/usr/bin/env bash
# Lints and renders the chart with the values a deployment sets, not only its defaults, which leave
# the runners, the Ingress, and GitHub sign-in off, and checks that it refuses values its first
# start would fail on. Needs helm on the PATH. Usage: check.sh [chart directory]
set -euo pipefail

chart=${1:-helm/stellaris}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# Each case is a name, the --set flags of one deployment, and any lines its rendering must hold,
# each after a further |.
cases=(
  "defaults|"
  "everything on|--set ingress.enabled=true --set ingress.className=nginx --set ingress.tls.enabled=true \
--set ingress.tls.secretName=stellaris-tls --set auth.github.enabled=true --set auth.github.clientId=client-1 \
--set auth.github.clientSecret=secret-1 --set auth.github.users={octocat,12345} --set server.config.trustedProxies=2 \
--set server.config.concurrency=4 --set server.config.timings.opsIntervalMs=60000 --set runner.enabled=true \
--set runner.replicas=2 --set runner.config.capabilities={gpu} --set runner.networkPolicy.enabled=true \
--set runner.extraVolumes[0].name=ssh-key --set runner.extraVolumes[0].secret.secretName=ssh-key \
--set runner.extraInitContainers[0].name=install-ssh-key --set runner.extraInitContainers[0].image=busybox:1.37 \
--set auth.github.appleAppId=ABCDE12345.com.example.app\
|            - name: STELLARIS_APPLE_APP_ID|              value: \"ABCDE12345.com.example.app\""
  "runners only|--set server.enabled=false --set runner.enabled=true --set runner.serverUrl=https://stellaris.example.com \
--set runner.existingSecret=runner-token --set persistence.enabled=false\
|      serviceAccountName: default|      automountServiceAccountToken: false"
  "runners with a service account's token|--set runner.enabled=true --set runner.serviceAccountName=runner-reader \
--set runner.automountServiceAccountToken=true\
|      serviceAccountName: runner-reader|      automountServiceAccountToken: true"
  "an existing claim and secret|--set persistence.existingClaim=stellaris-data --set auth.github.enabled=true \
--set auth.github.clientId=client-1 --set auth.github.existingSecret=github-oauth --set auth.github.users={octocat}"
)
# Each refusal is the message the chart must fail with, and the --set flags that ask for it.
refusals=(
  "runner.extraVolumes: home is the runner's claim|--set runner.enabled=true --set runner.extraVolumes[0].name=home \
--set runner.extraVolumes[0].emptyDir.medium=Memory"
  "auth.github.clientId is required|--set auth.github.enabled=true"
  "auth.github.appleAppId needs GitHub sign-in|--set auth.github.appleAppId=ABCDE12345.com.example.app"
  "is not <team id>.<bundle id>|--set auth.github.enabled=true --set auth.github.clientId=client-1 \
--set auth.github.clientSecret=secret-1 --set auth.github.users={octocat} --set auth.github.appleAppId=com.example.app"
  "runner.existingSecret holds one runner's token|--set runner.enabled=true --set runner.existingSecret=runner-token \
--set runner.replicas=2"
)

for entry in "${cases[@]}"; do
  IFS='|' read -r -a parts <<< "$entry"
  name=${parts[0]}
  read -r -a flags <<< "${parts[1]-}"
  helm lint --strict "$chart" "${flags[@]}" > "$out/lint" || { cat "$out/lint"; echo "lint failed: $name"; exit 1; }
  helm template stellaris "$chart" --namespace stellaris "${flags[@]}" > "$out/rendered" ||
    { echo "render failed: $name"; exit 1; }
  echo "$name: $(grep -c '^kind: ' "$out/rendered") objects ($(grep '^kind: ' "$out/rendered" | sort | uniq -c | awk '{printf "%s%s %s", sep, $1, $3; sep=", "}'))"
  for line in "${parts[@]:2}"; do
    grep -qxF -- "$line" "$out/rendered" || { echo "$name: the rendering lacks \"$line\""; exit 1; }
    echo "  holds \"${line#"${line%%[! ]*}"}\""
  done
done

for entry in "${refusals[@]}"; do
  message=${entry%%|*}
  read -r -a flags <<< "${entry#*|}"
  if helm template stellaris "$chart" "${flags[@]}" > /dev/null 2> "$out/error"; then
    echo "the chart rendered values it must refuse: ${entry#*|}"
    exit 1
  fi
  grep -qF "$message" "$out/error" || { cat "$out/error"; echo "the chart failed without: $message"; exit 1; }
  echo "refused: $message"
done
