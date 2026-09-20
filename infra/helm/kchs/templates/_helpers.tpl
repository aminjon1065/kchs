{{/*
Общие помощники чарта kchs (ADR-0118).

Правила:
  • окружение api и worker — одно и то же (как x-app-env в compose), чтобы
    процессы не расходились: несекретное — в ConfigMap, секреты — в Secret;
  • строки подключения собираются из адреса и пароля прямо в spec пода
    подстановкой $(ПЕРЕМЕННАЯ) kubelet; если у управляемой службы DSN сложнее
    (параметры, сертификаты), его кладут в секрет целиком — *.urlsFromSecret.
*/}}

{{/*
Проверка сочетаний значений, которые молча дали бы неработающую установку.
Вызывается один раз из configmap-env.yaml (он рендерится всегда).
*/}}
{{- define "kchs.validate" -}}
{{- if and .Values.postgres.embedded.enabled .Values.postgres.urlsFromSecret -}}
{{- fail "postgres.urlsFromSecret несовместим со встроенным Postgres: бутстрапу кластера нужны отдельные пароли ролей" -}}
{{- end -}}
{{- if and .Values.redis.embedded.enabled .Values.redis.urlFromSecret -}}
{{- fail "redis.urlFromSecret несовместим со встроенным Redis: ему нужен пароль ключом REDIS_PASSWORD" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) -}}
{{- fail "ingress.host обязателен при ingress.enabled" -}}
{{- end -}}
{{- if and (eq .Values.worker.autoscaling.mode "keda") (not .Values.worker.autoscaling.keda.triggers) (not .Values.worker.autoscaling.keda.prometheusAddress) -}}
{{- fail "worker.autoscaling.keda.prometheusAddress обязателен при mode=keda (или задайте свои keda.triggers)" -}}
{{- end -}}
{{- if and (eq .Values.engine.autoscaling.mode "keda") (not .Values.engine.autoscaling.keda.triggers) (not .Values.engine.autoscaling.keda.prometheusAddress) -}}
{{- fail "engine.autoscaling.keda.prometheusAddress обязателен при mode=keda (или задайте свои keda.triggers)" -}}
{{- end -}}
{{- end -}}

{{- define "kchs.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kchs.fullname" -}}
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

{{- define "kchs.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kchs.labels" -}}
helm.sh/chart: {{ include "kchs.chart" . }}
app.kubernetes.io/name: {{ include "kchs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kchs
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Метки выбора пода: include "kchs.selectorLabels" (dict "ctx" $ "component" "api") */}}
{{- define "kchs.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kchs.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "kchs.componentLabels" -}}
{{ include "kchs.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "kchs.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kchs.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Имя секрета установки: внешний менеджер (existingSecret) или свой Secret */}}
{{- define "kchs.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "kchs.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "kchs.configMapName" -}}
{{- printf "%s-env" (include "kchs.fullname" .) -}}
{{- end -}}

{{/*
Образ: include "kchs.image" (dict "ctx" $ "image" .Values.api.image)
Тег по умолчанию — общий values.image.tag (версия установки).
*/}}
{{- define "kchs.image" -}}
{{- $registry := default .ctx.Values.global.imageRegistry .image.registry -}}
{{- $tag := default .ctx.Values.image.tag .image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $registry) .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "kchs.imagePullSecrets" -}}
{{- $secrets := concat .Values.global.imagePullSecrets .Values.imagePullSecrets -}}
{{- if $secrets }}
imagePullSecrets:
{{- range $secrets }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Имена служб встроенных зависимостей */}}
{{- define "kchs.postgres.host" -}}
{{- if .Values.postgres.embedded.enabled -}}
{{- printf "%s-postgres" (include "kchs.fullname" .) -}}
{{- else -}}
{{- required "postgres.host обязателен, если postgres.embedded.enabled=false" .Values.postgres.host -}}
{{- end -}}
{{- end -}}

{{- define "kchs.redis.host" -}}
{{- if .Values.redis.embedded.enabled -}}
{{- printf "%s-redis" (include "kchs.fullname" .) -}}
{{- else -}}
{{- required "redis.host обязателен, если redis.embedded.enabled=false" .Values.redis.host -}}
{{- end -}}
{{- end -}}

{{- define "kchs.s3.endpoint" -}}
{{- if .Values.s3.embedded.enabled -}}
{{- printf "http://%s-minio:9000" (include "kchs.fullname" .) -}}
{{- else -}}
{{- required "s3.endpoint обязателен, если s3.embedded.enabled=false" .Values.s3.endpoint -}}
{{- end -}}
{{- end -}}

{{- define "kchs.meili.host" -}}
{{- if .Values.meilisearch.embedded.enabled -}}
{{- printf "http://%s-meilisearch:7700" (include "kchs.fullname" .) -}}
{{- else -}}
{{- required "meilisearch.host обязателен, если meilisearch.embedded.enabled=false" .Values.meilisearch.host -}}
{{- end -}}
{{- end -}}

{{- define "kchs.api.url" -}}
{{- printf "http://%s-api:%d" (include "kchs.fullname" .) (int .Values.api.service.port) -}}
{{- end -}}

{{- define "kchs.web.url" -}}
{{- printf "http://%s-web:%d" (include "kchs.fullname" .) (int .Values.web.service.port) -}}
{{- end -}}

{{- define "kchs.engine.url" -}}
{{- printf "http://%s-engine:%d" (include "kchs.fullname" .) (int .Values.engine.service.port) -}}
{{- end -}}

{{/* Публичный адрес установки — база для ссылок в письмах и уведомлениях */}}
{{- define "kchs.baseUrl" -}}
{{- if .Values.baseUrl -}}
{{- trimSuffix "/" .Values.baseUrl -}}
{{- else -}}
{{- $scheme := ternary "https" "http" .Values.ingress.tls.enabled -}}
{{- printf "%s://%s" $scheme (required "ingress.host или baseUrl обязателен" .Values.ingress.host) -}}
{{- end -}}
{{- end -}}

{{/*
Переменные подключения к Postgres.
  include "kchs.dbEnv" (dict "ctx" $ "roles" (list "app" "migrator" "query"))
Роль app → DATABASE_URL, migrator → DATABASE_MIGRATOR_URL, query → DATABASE_QUERY_URL.
*/}}
{{- define "kchs.dbEnv" -}}
{{- $ctx := .ctx -}}
{{- $pg := $ctx.Values.postgres -}}
{{- $secret := include "kchs.secretName" $ctx -}}
{{- $host := include "kchs.postgres.host" $ctx -}}
{{- $suffix := dict "app" "DATABASE_URL" "migrator" "DATABASE_MIGRATOR_URL" "query" "DATABASE_QUERY_URL" -}}
{{- $pwKey := dict "app" "POSTGRES_APP_PASSWORD" "migrator" "POSTGRES_MIGRATOR_PASSWORD" "query" "POSTGRES_QUERY_PASSWORD" -}}
{{- $user := dict "app" $pg.users.app "migrator" $pg.users.migrator "query" $pg.users.query -}}
{{- range .roles }}
{{- $var := get $suffix . }}
{{- if $pg.urlsFromSecret }}
- name: {{ $var }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $var }}
{{- else }}
- name: {{ get $pwKey . }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ get $pwKey . }}
- name: {{ $var }}
  value: {{ printf "postgres://%s:$(%s)@%s:%d/%s%s" (get $user .) (get $pwKey .) $host (int $pg.port) $pg.database (ternary (printf "?sslmode=%s" $pg.sslMode) "" (ne $pg.sslMode "")) | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "kchs.redisEnv" -}}
{{- $ctx := .ctx -}}
{{- $redis := $ctx.Values.redis -}}
{{- $secret := include "kchs.secretName" $ctx -}}
{{- if $redis.urlFromSecret }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: REDIS_URL
{{- else }}
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: REDIS_PASSWORD
- name: REDIS_URL
  value: {{ printf "%s://:$(REDIS_PASSWORD)@%s:%d" (ternary "rediss" "redis" $redis.tls) (include "kchs.redis.host" $ctx) (int $redis.port) | quote }}
{{- end }}
{{- end -}}

{{- define "kchs.s3Env" -}}
{{- $secret := include "kchs.secretName" .ctx -}}
- name: S3_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: S3_ACCESS_KEY
- name: S3_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: S3_SECRET_KEY
{{- end -}}

{{/* Секреты, общие для api, worker, миграций и разовых заданий */}}
{{- define "kchs.appSecretEnv" -}}
{{- $ctx := .ctx -}}
{{- $secret := include "kchs.secretName" $ctx -}}
- name: MEILI_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: MEILI_MASTER_KEY
- name: KCHS_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: KCHS_MASTER_KEY
- name: INTERNAL_SERVICE_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: INTERNAL_SERVICE_TOKEN
{{- range $var, $key := $ctx.Values.secrets.optionalKeys }}
- name: {{ $var }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- end -}}

{{/*
Полный набор env для процессов api/worker/CLI. Каждая часть нормализуется
(trim + nindent 0): помощники выше сами по себе завершающего перевода строки не
дают, и без этого соседние списки склеились бы в одну строку.
*/}}
{{- define "kchs.appEnv" -}}
{{- include "kchs.dbEnv" (dict "ctx" .ctx "roles" (list "app" "migrator" "query")) | trim | nindent 0 }}
{{- include "kchs.redisEnv" (dict "ctx" .ctx) | trim | nindent 0 }}
{{- include "kchs.s3Env" (dict "ctx" .ctx) | trim | nindent 0 }}
{{- include "kchs.appSecretEnv" (dict "ctx" .ctx) | trim | nindent 0 }}
{{- with .ctx.Values.extraEnv }}
{{- toYaml . | trim | nindent 0 }}
{{- end }}
{{- end -}}

{{/*
Контейнер ожидания Postgres: образ api несёт клиент PostgreSQL 17 (pg_isready).
Нужен там, где Helm не гарантирует порядок (встроенный Postgres, задание миграций).
*/}}
{{- define "kchs.waitForPostgres" -}}
- name: wait-postgres
  image: {{ include "kchs.image" (dict "ctx" .ctx "image" .ctx.Values.api.image) }}
  imagePullPolicy: {{ .ctx.Values.image.pullPolicy }}
  securityContext:
    {{- toYaml .ctx.Values.containerSecurityContext | nindent 4 }}
  command:
    - sh
    - -ec
    - |
      # Ждём, пока кластер начнёт принимать подключения: без этого задание
      # миграций падает на первой установке, пока Postgres ещё поднимается
      for i in $(seq 1 {{ .ctx.Values.waitForDependencies.retries }}); do
        pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1 && exit 0
        sleep {{ .ctx.Values.waitForDependencies.intervalSeconds }}
      done
      echo "postgres $PGHOST:$PGPORT не отвечает" >&2
      exit 1
  env:
    - name: PGHOST
      value: {{ include "kchs.postgres.host" .ctx | quote }}
    - name: PGPORT
      value: {{ .ctx.Values.postgres.port | quote }}
  resources:
    {{- toYaml .ctx.Values.waitForDependencies.resources | nindent 4 }}
{{- end -}}

{{/*
Очереди BullMQ по исполнителям — QUEUE_RUNTIME в packages/contracts/src/jobs/job.ts
(ADR-0035). Значение подставляется в запрос KEDA как регулярное выражение.
*/}}
{{- define "kchs.workerQueues" -}}
{{- $queues := .Values.worker.autoscaling.keda.queues -}}
{{- if $queues -}}
{{- join "|" $queues -}}
{{- else -}}
exports|index|notify|automation|process-timers|maintenance|data
{{- end -}}
{{- end -}}

{{- define "kchs.engineQueues" -}}
{{- $queues := .Values.engine.autoscaling.keda.queues -}}
{{- if $queues -}}
{{- join "|" $queues -}}
{{- else -}}
imports|transform|render|media|ai
{{- end -}}
{{- end -}}
