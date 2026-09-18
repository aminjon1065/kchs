#!/usr/bin/env bash
# Установка с нуля — критерий готовности фазы 0 (docs/04-delivery/02-roadmap.md):
# «docker compose up + kchs init дают рабочую систему за ≤ 10 минут».
#
#   секреты (--mode app) → сборка образов → docker compose --profile app up --wait
#   → kchs init → kchs seed → смена временного пароля администратора
#   → дымовой прогон API через web → браузер: вход, «Мой день», загрузка в S3, превью
#
# Отдельный проект compose со своими портами и томами — стенд разработки не
# затрагивается; в конце проект удаляется вместе с томами.
#
#   bash infra/scripts/verify-stack.sh                # со сборкой образов
#   SKIP_BUILD=1 bash infra/scripts/verify-stack.sh   # образы уже собраны (KCHS_IMAGE_TAG)
#   KEEP=1 bash infra/scripts/verify-stack.sh         # оставить стенд после проверки
#   KCHS_VERIFY_PERF=1 bash infra/scripts/verify-stack.sh  # и бюджеты p95 API (k6, ~2 мин)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${KCHS_VERIFY_PROJECT:-kchs-verify}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kchs-verify.XXXXXX")"
ENV_FILE="$WORK/verify.env"

export POSTGRES_PORT="${POSTGRES_PORT:-55432}" REDIS_PORT="${REDIS_PORT:-56379}"
export S3_PORT="${S3_PORT:-59000}" S3_CONSOLE_PORT="${S3_CONSOLE_PORT:-59001}"
export MEILI_PORT="${MEILI_PORT:-57700}" MAILPIT_SMTP_PORT="${MAILPIT_SMTP_PORT:-51025}"
export MAILPIT_UI_PORT="${MAILPIT_UI_PORT:-58025}" API_PORT="${API_PORT:-53000}"
export ENGINE_PORT="${ENGINE_PORT:-58000}" WEB_PORT="${WEB_PORT:-58080}"
export WEB_HTTPS_PORT="${WEB_HTTPS_PORT:-58443}" KCHS_IMAGE_TAG="${KCHS_IMAGE_TAG:-verify}"

bash "$ROOT/infra/scripts/generate-secrets.sh" --mode app --env-file "$ENV_FILE" >/dev/null

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/infra/compose/docker-compose.yml" --profile app "$@"
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "── Журналы при сбое ──" >&2
    compose logs --tail=60 api worker engine web >&2 || true
  fi
  if [[ "${KEEP:-0}" != 1 ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  else
    echo "Стенд оставлен: проект $PROJECT, окружение $ENV_FILE"
  fi
  exit $status
}
trap cleanup EXIT

stamp() { date +%s; }

T0=$(stamp)
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  echo "── Сборка образов ──"
  # Образы приложения — под своим тегом (KCHS_IMAGE_TAG)
  compose build api web engine
fi
# Образ postgres общий со стендом разработки (тег не зависит от KCHS_IMAGE_TAG):
# собирается, только если его ещё нет, — готовый образ стенда не пересобирается
PG_IMAGE="$(compose config --format json \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["services"]["postgres"]["image"])')"
docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || compose build postgres
T1=$(stamp)

echo "── docker compose up ──"
compose up -d --wait --wait-timeout 600
T2=$(stamp)

echo "── kchs init ──"
INIT="$(compose exec -T api kchs init --admin-login admin --admin-email admin@kchs.local)"
printf '%s\n' "$INIT"
TEMP="$(printf '%s\n' "$INIT" | sed -n 's/^ *Временный пароль: //p' | head -1)"
[[ -n "$TEMP" ]] || { echo "kchs init не выдал временный пароль" >&2; exit 1; }
T3=$(stamp)

echo "── Демо-данные ──"
compose exec -T api kchs seed
T4=$(stamp)

BASE="http://localhost:$WEB_PORT"
# Первый вход администратора: временный пароль меняется на свой (как в интерфейсе)
NEW_PASSWORD="Stand!Check-$(openssl rand -hex 4)-2026"
JAR="$WORK/admin.jar"
CSRF="$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"login\":\"admin\",\"password\":\"$TEMP\"}" "$BASE/api/v1/auth/login" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("csrfToken",""))')"
curl -fsS -o /dev/null -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d "{\"currentPassword\":\"$TEMP\",\"newPassword\":\"$NEW_PASSWORD\",\"revokeOtherSessions\":true}" \
  "$BASE/api/v1/me/password"

echo "── Дымовой прогон API через web ──"
KCHS_SMOKE_BASE="$BASE/api/v1" KCHS_SMOKE_ADMIN_PASSWORD="$NEW_PASSWORD" \
  bash "$ROOT/infra/scripts/smoke-api.sh"

echo "── Браузер ──"
STACK_URL="$BASE" STACK_ADMIN_PASSWORD="$NEW_PASSWORD" STACK_S3_ORIGIN="http://localhost:$S3_PORT" \
  pnpm --dir "$ROOT/apps/web" exec node scripts/stack-check.mjs
T5=$(stamp)

TIMES="Время: сборка образов $((T1 - T0)) с; up до готовности $((T2 - T1)) с; kchs init $((T3 - T2)) с; демо-данные $((T4 - T3)) с; проверки $((T5 - T4)) с
От docker compose up до рабочей системы (up + kchs init): $((T3 - T1)) с"
echo
echo "$TIMES"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Установка в контейнерах\n\n```\n%s\n```\n' "$TIMES" >> "$GITHUB_STEP_SUMMARY"
fi

# Бюджеты p95 API (04-verification.md §4) на только что поднятом стенде — через web,
# как ходит браузер. В CI — ночью и вручную (KCHS_VERIFY_PERF=1), на PR не нужно
if [[ "${KCHS_VERIFY_PERF:-0}" == 1 ]]; then
  echo "── Бюджеты API (k6) ──"
  KCHS_PERF_API="http://host.docker.internal:$WEB_PORT/api/v1" \
    KCHS_PERF_ADMIN_PASSWORD="$NEW_PASSWORD" \
    KCHS_PERF_DURATION="${KCHS_PERF_DURATION:-1m}" \
    bash "$ROOT/infra/perf/run-k6.sh"
fi
