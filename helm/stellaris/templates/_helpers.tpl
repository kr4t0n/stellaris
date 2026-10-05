{{/*
Expand the name of the chart.
*/}}
{{- define "stellaris.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A prefix every object shares: fullnameOverride, else "<release>-<chart>", so two releases of the
chart can share a namespace.
*/}}
{{- define "stellaris.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "stellaris.server.fullname" -}}
{{- printf "%s-server" (include "stellaris.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stellaris.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "stellaris.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels leave out the version and the chart, since a Deployment's selector cannot change.
*/}}
{{- define "stellaris.server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stellaris.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{/*
The component's tag, else the top-level tag, else the chart's appVersion.
*/}}
{{- define "stellaris.server.image" -}}
{{- $registry := .Values.image.registry | default "docker.io" -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) .Values.server.image.tag -}}
{{- printf "%s/%s:%s" $registry .Values.server.image.repository $tag -}}
{{- end -}}

{{- define "stellaris.github.secretName" -}}
{{- .Values.auth.github.existingSecret | default (printf "%s-github" (include "stellaris.server.fullname" .)) -}}
{{- end -}}

{{- define "stellaris.server.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "stellaris.server.fullname" .)) -}}
{{- end -}}

{{/*
Refuses at install what the first start would fail on, a citizen the society cannot create, and
anything the init container's script would have to quote: names, roles, CLIs, and models are
plain words by these checks.
*/}}
{{- define "stellaris.validate" -}}
{{- $proxies := .Values.server.config.trustedProxies -}}
{{- if not (or (kindIs "invalid" $proxies) (regexMatch "^[0-9]*$" (toString $proxies))) -}}
{{- fail (printf "server.config.trustedProxies must be a number of proxies or empty, not %q" (toString $proxies)) -}}
{{- end -}}
{{- $github := .Values.auth.github -}}
{{- if $github.enabled -}}
{{- if not $github.clientId -}}
{{- fail "auth.github.clientId is required when GitHub sign-in is enabled" -}}
{{- end -}}
{{- if not (or $github.clientSecret $github.existingSecret) -}}
{{- fail "auth.github needs clientSecret, or existingSecret naming a Secret that holds it" -}}
{{- end -}}
{{- if not $github.users -}}
{{- fail "auth.github.users must list the GitHub logins allowed to sign in" -}}
{{- end -}}
{{- range $github.users -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$" (toString .)) -}}
{{- fail (printf "auth.github.users: %q is not a GitHub login or user id" (toString .)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- range .Values.society.citizens -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{0,31}$" (toString .name)) -}}
{{- fail (printf "society.citizens: %q is not a citizen name (lowercase letters, digits, and dashes, up to 32)" (toString .name)) -}}
{{- end -}}
{{- if not (has .role (list "concierge" "steward")) -}}
{{- fail (printf "society.citizens: %s's role %q does not exist on first start; only concierge and steward do" .name (toString .role)) -}}
{{- end -}}
{{- if and .cli (not (has .cli (list "claude" "codex"))) -}}
{{- fail (printf "society.citizens: %s's cli must be claude or codex, not %q" .name (toString .cli)) -}}
{{- end -}}
{{- if and .model (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._:/@-]*$" (toString .model))) -}}
{{- fail (printf "society.citizens: %s's model %q is not a model name" .name (toString .model)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
