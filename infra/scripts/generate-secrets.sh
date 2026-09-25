#!/usr/bin/env bash
# Генерирует .env из .env.example, подставляя случайные секреты.
#
#   bash infra/scripts/generate-secrets.sh [--force] [--mode dev|app] [--env-file ПУТЬ]
#
#   --mode dev  (по умолчанию) разработка: в Docker — инфраструктура и движок,
#               api и web запускаются на хосте (pnpm dev)
#   --mode app  всё в контейнерах: docker compose --profile app up -d, затем
#               docker compose exec api kchs init; вход через web (Caddy)
#   --env-file  куда записать (по умолчанию .env в корне репозитория)
#
# Порты и привязку можно задать переменными окружения при запуске скрипта:
# POSTGRES_PORT, REDIS_PORT, S3_PORT, S3_CONSOLE_PORT, MEILI_PORT, MAILPIT_SMTP_PORT,
# MAILPIT_UI_PORT, API_PORT, ENGINE_PORT, WEB_PORT, WEB_HTTPS_PORT, GRAFANA_PORT,
# ALERTMANAGER_PORT, KCHS_BIND, KCHS_IMAGE_TAG — например, для второго стенда рядом
# с основным.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE="$ROOT/.env.example"
ENV_FILE="$ROOT/.env"
MODE=dev
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --mode) MODE="${2:?укажите dev или app}"; shift ;;
    --env-file) ENV_FILE="${2:?укажите путь}"; shift ;;
    *) echo "неизвестный параметр: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$MODE" == dev || "$MODE" == app ]] || { echo "--mode: dev или app" >&2; exit 2; }

if [[ -f "$ENV_FILE" && "$FORCE" != 1 ]]; then
  echo "$ENV_FILE уже существует. Повторить с --force, чтобы перезаписать." >&2
  exit 1
fi

rnd() { openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-"${1:-32}"; }
b64key() { openssl rand -base64 32; }
# Ключи VAPID для push (ADR-0094): пара P-256 в base64url — приватный скаляр и
# несжатая открытая точка из DER-структуры SEC1 (фиксированные смещения)
vapid_keys() {
  local der
  der="$(mktemp)"
  openssl ecparam -name prime256v1 -genkey -noout -outform DER -out "$der" 2>/dev/null
  VAPID_PRIVATE="$(dd if="$der" bs=1 skip=7 count=32 2>/dev/null | base64 | tr '+/' '-_' | tr -d '=\n')"
  VAPID_PUBLIC="$(tail -c 65 "$der" | base64 | tr '+/' '-_' | tr -d '=\n')"
  rm -f "$der"
}

PG_SUPER="$(rnd 32)"; PG_APP="$(rnd 32)"; PG_MIGRATOR="$(rnd 32)"
PG_QUERY="$(rnd 32)"; PG_READONLY="$(rnd 32)"; PG_AUDIT="$(rnd 32)"
# Роль экспортёра метрик Postgres (ADR-0147): только pg_monitor
PG_MONITOR="$(rnd 32)"
REDIS_PW="$(rnd 32)"; S3_SECRET="$(rnd 40)"; MEILI_KEY="$(rnd 40)"
MASTER_KEY="$(b64key)"; INTERNAL_TOKEN="$(rnd 48)"; GRAFANA_PW="$(rnd 24)"
# Медиасервер встреч (ADR-0089): ключ и секрет — пара для токенов комнат
LIVEKIT_KEY="$(rnd 16)"; LIVEKIT_SECRET="$(rnd 48)"
# Сервер документов ONLYOFFICE (ADR-0112): общий секрет подписи в обе стороны
ONLYOFFICE_SECRET="$(rnd 48)"
vapid_keys

mkdir -p "$(dirname "$ENV_FILE")"
cp "$EXAMPLE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# BSD/GNU-совместимая замена (значение передаётся через окружение,
# чтобы @ и другие спецсимволы не интерпретировались)
repl() { KEY="$1" VAL="$2" perl -pi -e 's#^\Q$ENV{KEY}\E=.*#$ENV{KEY}."=".$ENV{VAL}#e' "$ENV_FILE"; }
# Заменить значение ключа или дописать ключ, если в примере его нет
set_kv() {
  if grep -q "^$1=" "$ENV_FILE"; then repl "$1" "$2"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}

repl POSTGRES_SUPERUSER_PASSWORD "$PG_SUPER"
repl KCHS_APP_PASSWORD "$PG_APP"
repl KCHS_MIGRATOR_PASSWORD "$PG_MIGRATOR"
repl KCHS_QUERY_PASSWORD "$PG_QUERY"
repl KCHS_READONLY_PASSWORD "$PG_READONLY"
repl KCHS_AUDIT_PASSWORD "$PG_AUDIT"
repl KCHS_MONITOR_PASSWORD "$PG_MONITOR"
repl REDIS_PASSWORD "$REDIS_PW"
repl S3_SECRET_KEY "$S3_SECRET"
repl MEILI_MASTER_KEY "$MEILI_KEY"
repl KCHS_MASTER_KEY "$MASTER_KEY"
repl INTERNAL_SERVICE_TOKEN "$INTERNAL_TOKEN"
repl GRAFANA_ADMIN_PASSWORD "$GRAFANA_PW"
repl LIVEKIT_API_KEY "$LIVEKIT_KEY"
repl LIVEKIT_API_SECRET "$LIVEKIT_SECRET"
repl ONLYOFFICE_JWT_SECRET "$ONLYOFFICE_SECRET"
repl PUSH_VAPID_PUBLIC_KEY "$VAPID_PUBLIC"
repl PUSH_VAPID_PRIVATE_KEY "$VAPID_PRIVATE"

# Порты и привязка — из окружения, если заданы
for key in POSTGRES_PORT REDIS_PORT S3_PORT S3_CONSOLE_PORT MEILI_PORT MAILPIT_SMTP_PORT \
  MAILPIT_UI_PORT API_PORT ENGINE_PORT WEB_PORT WEB_HTTPS_PORT LIVEKIT_PORT ONLYOFFICE_PORT \
  GRAFANA_PORT ALERTMANAGER_PORT KCHS_BIND KCHS_IMAGE_TAG; do
  if [[ -n "${!key:-}" ]]; then set_kv "$key" "${!key}"; fi
done

PG_PORT="${POSTGRES_PORT:-5432}"
S3P="${S3_PORT:-9000}"

# Адреса для процессов на хосте (api при разработке, kchs через pnpm, тесты)
repl DATABASE_URL "postgres://kchs_app:$PG_APP@localhost:$PG_PORT/kchs"
repl DATABASE_MIGRATOR_URL "postgres://kchs_migrator:$PG_MIGRATOR@localhost:$PG_PORT/kchs"
repl DATABASE_QUERY_URL "postgres://kchs_query:$PG_QUERY@localhost:$PG_PORT/kchs"
repl REDIS_URL "redis://:$REDIS_PW@localhost:${REDIS_PORT:-6379}"
set_kv S3_ENDPOINT "http://localhost:$S3P"
set_kv MEILI_HOST "http://localhost:${MEILI_PORT:-7700}"
set_kv SMTP_URL "smtp://localhost:${MAILPIT_SMTP_PORT:-1025}"
set_kv ENGINE_INTERNAL_URL "http://localhost:${ENGINE_PORT:-8000}"
# Браузер ходит в хранилище по подписанным ссылкам: этот адрес и origin для CSP
set_kv S3_PUBLIC_ENDPOINT "http://localhost:$S3P"
set_kv KCHS_STORAGE_ORIGIN "http://localhost:$S3P"
set_kv MINIO_CONSOLE_URL "http://localhost:${S3_CONSOLE_PORT:-9001}"
# Медиасервер: браузер подключается к нему напрямую (профиль media)
set_kv LIVEKIT_URL "ws://localhost:${LIVEKIT_PORT:-7880}"
# Тот же адрес в CSP собранного веба: браузер подключается к комнате напрямую
set_kv KCHS_MEDIA_ORIGIN "ws://localhost:${LIVEKIT_PORT:-7880}"
# Сервер документов: браузер грузит с него редактор (профиль office)
set_kv ONLYOFFICE_URL "http://localhost:${ONLYOFFICE_PORT:-8082}"

if [[ "$MODE" == app ]]; then
  WEB="${WEB_PORT:-8080}"
  set_kv NODE_ENV production
  set_kv LOG_LEVEL info
  set_kv KCHS_BASE_URL "http://localhost:$WEB"
  set_kv KCHS_API_URL "http://localhost:$WEB/api"
  # HTTP без сертификата; для домена с автоматическим HTTPS — KCHS_DOMAIN=домен,
  # WEB_PORT=80, WEB_HTTPS_PORT=443 (и S3 по HTTPS — см. README)
  set_kv KCHS_DOMAIN ":80"
  set_kv ENGINE_API_URL "http://api:3000"
  set_kv ENGINE_WEB_URL "http://web"
  # Сервер документов живёт в сети развёртывания: api ходит к нему по имени,
  # а он в api — тоже по имени
  set_kv ONLYOFFICE_INTERNAL_URL "http://onlyoffice"
  set_kv ONLYOFFICE_CALLBACK_URL "http://api:3000"
fi

echo "Создан $ENV_FILE (режим 600, $MODE). Секреты сгенерированы."
