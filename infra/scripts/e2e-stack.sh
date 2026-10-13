#!/usr/bin/env bash
# Сквозные сценарии (Playwright) на временном стенде. Стенд разработки держит реальные
# данные Комитета, а сценарии создают сотни объектов — поэтому они идут на отдельном
# проекте compose со своими портами и томами, с демо-данными, и в конце он удаляется.
#
# Устроен как стенд разработки: инфраструктура и движок — в Docker, api и web — на хосте
# (приёмник вебхуков и заглушки ИИ в сценариях слушают 127.0.0.1 хоста).
#
#   bash infra/scripts/e2e-stack.sh                    # поднять, весь набор, удалить
#   bash infra/scripts/e2e-stack.sh all forms-offline  # то же для выбранных файлов
#   bash infra/scripts/e2e-stack.sh up                 # только поднять (и демо-данные)
#   bash infra/scripts/e2e-stack.sh run [файлы…]       # прогон на поднятом стенде
#   bash infra/scripts/e2e-stack.sh down               # удалить стенд вместе с томами
#
# Порты: база 45432, Redis 46379, хранилище 49000, поиск 47700, почта 48025/41025,
# движок 48000, api 3100, web 5174. Образ движка — `kchs/engine:${KCHS_IMAGE_TAG:-0.1.0}`
# (без сборки). Подложка — из seeds/.cache/basemaps/out, если она собрана.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${KCHS_E2E_PROJECT:-kchs-e2e}"
STATE="${KCHS_E2E_DIR:-${TMPDIR:-/tmp}/kchs-e2e}"
ENV_FILE="$STATE/e2e.env"
API_PORT_HOST=3100
WEB_PORT_HOST=5174

export POSTGRES_PORT=45432 REDIS_PORT=46379 S3_PORT=49000 S3_CONSOLE_PORT=49001
export MEILI_PORT=47700 MAILPIT_SMTP_PORT=41025 MAILPIT_UI_PORT=48025 ENGINE_PORT=48000

say() { printf '%s\n' "$*"; }
die() { printf 'e2e-stack: %s\n' "$*" >&2; exit 1; }

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/infra/compose/docker-compose.yml" "$@"
}

kchs_cli() {
  (cd "$ROOT" && KCHS_ENV_FILE="$ENV_FILE" pnpm --silent --filter @kchs/api kchs "$@")
}

wait_http() {
  local url="$1" i
  for i in $(seq 1 90); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

# Окружение стенда разработки с переписанными портами: секреты — свои, случайные
make_env() {
  mkdir -p "$STATE"
  [[ -f "$ENV_FILE" ]] && return 0
  bash "$ROOT/infra/scripts/generate-secrets.sh" --mode dev --env-file "$ENV_FILE" >/dev/null
  python3 - "$ENV_FILE" "$API_PORT_HOST" "$WEB_PORT_HOST" <<'PY'
import re, sys
path, api, web = sys.argv[1], sys.argv[2], sys.argv[3]
ports = {'5432': '45432', '6379': '46379', '9000': '49000', '9001': '49001',
         '7700': '47700', '1025': '41025', '8025': '48025', '8000': '48000',
         '3000': api, '5173': web}
fixed = {
    'PORT': api, 'API_PORT': api,
    'WEBHOOKS_ALLOW_PRIVATE_ADDRESSES': 'true',
    'TELEGRAM_POLLING': 'false',
    'METRICS_PORT': '',
    # Полный набор — тысячи запросов одного администратора: лимит по умолчанию (600 в
    # минуту) к концу прогона отвечает 429, как у стенда разработки
    'RATE_LIMIT_PER_MINUTE': '20000',
    # Медиасервер — только у стенда разработки (порты UDP общие): встречи выключены,
    # их сценарии пропускаются сами
    'LIVEKIT_URL': '', 'LIVEKIT_API_KEY': '', 'LIVEKIT_API_SECRET': '',
}
out = []
for line in open(path, encoding='utf-8').read().splitlines():
    m = re.match(r'^([A-Z0-9_]+)=(.*)$', line)
    if not m:
        out.append(line)
        continue
    key, value = m.groups()
    if key in fixed:
        out.append(f'{key}={fixed.pop(key)}')
        continue
    value = re.sub(r'(localhost|127\.0\.0\.1|host\.docker\.internal):(\d{4})\b',
                   lambda g: f'{g.group(1)}:{ports.get(g.group(2), g.group(2))}', value)
    out.append(f'{key}={value}')
out += [f'{key}={value}' for key, value in fixed.items()]
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
}

start_host() {
  mkdir -p "$STATE/logs"
  (cd "$ROOT/apps/api" && KCHS_ENV_FILE="$ENV_FILE" nohup pnpm exec tsx src/main.ts \
    >"$STATE/logs/api.log" 2>&1 </dev/null & echo $! >"$STATE/api.pid")
  # IPv4 явно: «localhost» у Node может стать только [::1], а движок из Docker ходит на
  # host.docker.internal по IPv4 (печать отчётов)
  (cd "$ROOT/apps/web" && KCHS_API_URL="http://localhost:$API_PORT_HOST" nohup pnpm exec vite \
    --host 127.0.0.1 --port "$WEB_PORT_HOST" --strictPort >"$STATE/logs/web.log" 2>&1 </dev/null &
    echo $! >"$STATE/web.pid")
  wait_http "http://localhost:$API_PORT_HOST/health" || die "api не поднялся ($STATE/logs/api.log)"
  wait_http "http://127.0.0.1:$WEB_PORT_HOST/" || die "web не поднялся ($STATE/logs/web.log)"
}

stop_host() {
  local name pid
  for name in api web; do
    [[ -f "$STATE/$name.pid" ]] || continue
    pid="$(cat "$STATE/$name.pid")"
    # pnpm exec запускает дочерний процесс — гасится вся группа потомков
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$STATE/$name.pid"
  done
  # Порты освобождаются и у потомков, если pid обёртки уже ушёл
  for port in "$API_PORT_HOST" "$WEB_PORT_HOST"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

up() {
  make_env
  say "── Инфраструктура и движок ($PROJECT) ──"
  compose up -d --wait --wait-timeout 600 postgres redis minio minio-init meilisearch mailpit engine
  say "── Миграции ──"
  kchs_cli migrate >/dev/null
  say "── api :$API_PORT_HOST и web :$WEB_PORT_HOST ──"
  start_host
  say "── Демо-данные (оргструктура, сотрудники, пакет ЧС, датасеты small) ──"
  kchs_cli seed --data small 2>&1 | grep -viE 'парол|password' | tail -3
  # Сборка подложки лежит в основной копии репозитория — рабочая копия ветки её не видит
  local common basemap="${KCHS_E2E_BASEMAP:-$ROOT/seeds/.cache/basemaps/out}"
  if [[ ! -d "$basemap" ]]; then
    common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    [[ -n "$common" ]] && basemap="$(dirname "$common")/seeds/.cache/basemaps/out"
  fi
  if [[ -d "$basemap" ]]; then
    say "── Подложка ──"
    kchs_cli basemaps upload "$basemap" | tail -2
  fi
  say "Стенд готов: http://localhost:$WEB_PORT_HOST"
}

run() {
  [[ -f "$ENV_FILE" ]] || die "стенд не поднят: bash infra/scripts/e2e-stack.sh up"
  curl -fsS -o /dev/null "http://localhost:$API_PORT_HOST/health" 2>/dev/null || start_host
  (cd "$ROOT/apps/web" && KCHS_BASE_URL="http://localhost:$WEB_PORT_HOST" \
    MAILPIT_URL="http://localhost:$MAILPIT_UI_PORT" pnpm exec playwright test "$@")
}

down() {
  stop_host
  if [[ -f "$ENV_FILE" ]]; then
    compose --profile app down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$STATE"
  say "Стенд $PROJECT удалён вместе с томами"
}

case "${1:-all}" in
  up) up ;;
  run) shift; run "$@" ;;
  down) down ;;
  all)
    [[ $# -gt 0 ]] && shift
    up
    status=0
    run "$@" || status=$?
    down
    exit "$status"
    ;;
  *) die "команда: up | run [файлы…] | down | all [файлы…]" ;;
esac
