#!/usr/bin/env bash
# Генерирует .env из .env.example, подставляя случайные секреты.
# Запуск: bash infra/scripts/generate-secrets.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"

if [[ -f "$ENV_FILE" && "${1:-}" != "--force" ]]; then
  echo ".env уже существует. Повторить с --force, чтобы перезаписать." >&2
  exit 1
fi

rnd() { openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-"${1:-32}"; }
b64key() { openssl rand -base64 32; }

PG_SUPER="$(rnd 32)"; PG_APP="$(rnd 32)"; PG_MIGRATOR="$(rnd 32)"
PG_QUERY="$(rnd 32)"; PG_READONLY="$(rnd 32)"; PG_AUDIT="$(rnd 32)"
REDIS_PW="$(rnd 32)"; S3_SECRET="$(rnd 40)"; MEILI_KEY="$(rnd 40)"
MASTER_KEY="$(b64key)"; INTERNAL_TOKEN="$(rnd 48)"

cp "$EXAMPLE" "$ENV_FILE"

# BSD/GNU-совместимая замена (значение передаётся через окружение,
# чтобы @ и другие спецсимволы не интерпретировались)
repl() { KEY="$1" VAL="$2" perl -pi -e 's#^\Q$ENV{KEY}\E=.*#$ENV{KEY}."=".$ENV{VAL}#e' "$ENV_FILE"; }

repl POSTGRES_SUPERUSER_PASSWORD "$PG_SUPER"
repl KCHS_APP_PASSWORD "$PG_APP"
repl KCHS_MIGRATOR_PASSWORD "$PG_MIGRATOR"
repl KCHS_QUERY_PASSWORD "$PG_QUERY"
repl KCHS_READONLY_PASSWORD "$PG_READONLY"
repl KCHS_AUDIT_PASSWORD "$PG_AUDIT"
repl REDIS_PASSWORD "$REDIS_PW"
repl S3_SECRET_KEY "$S3_SECRET"
repl MEILI_MASTER_KEY "$MEILI_KEY"
repl KCHS_MASTER_KEY "$MASTER_KEY"
repl INTERNAL_SERVICE_TOKEN "$INTERNAL_TOKEN"

repl DATABASE_URL "postgres://kchs_app:$PG_APP@localhost:5432/kchs"
repl DATABASE_MIGRATOR_URL "postgres://kchs_migrator:$PG_MIGRATOR@localhost:5432/kchs"
repl DATABASE_QUERY_URL "postgres://kchs_query:$PG_QUERY@localhost:5432/kchs"
repl REDIS_URL "redis://:$REDIS_PW@localhost:6379"

chmod 600 "$ENV_FILE"
echo "Создан $ENV_FILE (режим 600). Секреты сгенерированы."
