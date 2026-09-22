{{- define "sentinel.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sentinel.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "sentinel.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "sentinel.labels" -}}
app.kubernetes.io/name: {{ include "sentinel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "sentinel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sentinel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* image "component" -> fully qualified reference */}}
{{- define "sentinel.image" -}}
{{- $root := .root -}}
{{- $tag := default $root.Chart.AppVersion $root.Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $root.Values.image.registry $root.Values.image.repository .component $tag -}}
{{- end -}}

{{/* envFrom block shared by every workload */}}
{{- define "sentinel.envFrom" -}}
- configMapRef:
    name: {{ include "sentinel.fullname" . }}-config
- secretRef:
    name: {{ .Values.secret.existingSecret | required "secret.existingSecret is required; create the Secret out of band" }}
{{- end -}}

{{- define "sentinel.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
fsGroup: 1000
{{- end -}}
