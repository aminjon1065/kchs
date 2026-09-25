#!/usr/bin/env bash
# Стенд демонстрации Комитету (ADR-0148): ноутбук владельца или арендованный VPS — одной
# командой. Всё в контейнерах (профиль app), демо-данные профиля small с пакетом ЧС,
# подложка карты, свои пароли демо-учёток. Руководство — docs/06-guides/30-demo-stand.md.
#
#   bash infra/scripts/demo-stand.sh up                      # ноутбук: http://localhost:8080
#   bash infra/scripts/demo-stand.sh up --domain demo.example.org --email you@example.org
#                                                            # VPS: HTTPS, сертификат Let's Encrypt
#   bash infra/scripts/demo-stand.sh reset [--build]         # перед показом: данные заново
#   bash infra/scripts/demo-stand.sh status                  # адрес, учётки, состояние служб
#   bash infra/scripts/demo-stand.sh kchs <команда>          # kchs в контейнере api
#   bash infra/scripts/demo-stand.sh logs [служба…]          # последние строки журналов
#   bash infra/scripts/demo-stand.sh down [--volumes --yes]  # остановить (и стереть всё)
#
# Ключи up: --data small|demo (по умолчанию small), --basemap КАТАЛОГ (по умолчанию
# seeds/.cache/basemaps/out, если он есть), --no-build (образы уже собраны). reset берёт
# собранные образы; --build — пересобрать после git pull.
# Окружение стенда — .env в корне копии (другой путь — KCHS_DEMO_ENV_FILE), проект
# compose — kchs (KCHS_DEMO_PROJECT). Порты — переменными WEB_PORT, WEB_HTTPS_PORT,
# S3_HTTPS_PORT и остальными из generate-secrets.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_DEMO_ENV_FILE:-$ROOT/.env}"
PROJECT="${KCHS_DEMO_PROJECT:-kchs}"
# Тома с данными: сброс стирает их, а сертификаты Caddy (caddydata) оставляет — иначе
# частые сбросы упёрлись бы в лимит Let's Encrypt: пять одинаковых сертификатов в неделю
DATA_VOLUMES=(pgdata redisdata miniodata meilidata)

say() { printf '%s\n' "$*"; }
die() {
  printf 'Ошибка: %s\n' "$*" >&2
  exit 1
}

env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# Значения без обратной косой черты: пароли и адреса стенда собирает сам скрипт
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/kchs-demo.XXXXXX")"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' \
      "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}

demo_password() { printf 'Demo!%s-Kc' "$(openssl rand -hex 6)"; }

compose() {
  local files=(-f "$ROOT/infra/compose/docker-compose.yml")
  # С доменом хранилище публикуется по HTTPS тем же Caddy на отдельном порту
  if [[ -n "$(env_get KCHS_DEMO_DOMAIN)" ]]; then
    files+=(-f "$ROOT/infra/compose/storage-https.yml")
  fi
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${files[@]}" --profile app "$@"
}

preflight() {
  command -v docker >/dev/null || die "нужен Docker 27+ с Compose v2 — https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 || die "Docker не запущен"
  docker compose version >/dev/null 2>&1 || die "нужен Docker Compose v2"
  command -v openssl >/dev/null || die "нужен openssl"
  local mem
  mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  if ((mem > 0 && mem < 7500000000)); then
    say "Внимание: Docker доступно $((mem / 1073741824)) ГБ памяти, стенду нужно не меньше 8 ГБ"
    say "(Docker Desktop → Settings → Resources → Memory)."
  fi
}

prepare_env() {
  if [[ -f "$ENV_FILE" ]]; then
    [[ "$(env_get NODE_ENV)" == production ]] ||
      die "$ENV_FILE — окружение стенда разработки. Стенд демонстрации ставьте в отдельной копии репозитория или с KCHS_DEMO_ENV_FILE=<другой путь>."
  else
    bash "$ROOT/infra/scripts/generate-secrets.sh" --mode app --env-file "$ENV_FILE" >/dev/null
    say "Создан $ENV_FILE со случайными секретами (права 600)"
  fi
  # Пароль демо-сотрудников — свой у каждого стенда: встроенный известен всем, кто видел код
  [[ -n "$(env_get SEED_USER_PASSWORD)" ]] || env_set SEED_USER_PASSWORD "$(demo_password)"
  [[ -n "$EMAIL" ]] && env_set KCHS_ADMIN_EMAIL "$EMAIL"
  if [[ -n "$DOMAIN" ]]; then
    local https="${WEB_HTTPS_PORT:-443}" s3="${S3_HTTPS_PORT:-9443}" port=""
    [[ "$https" == 443 ]] || port=":$https"
    env_set KCHS_DEMO_DOMAIN "$DOMAIN"
    env_set KCHS_DOMAIN "$DOMAIN"
    env_set WEB_PORT "${WEB_PORT:-80}"
    env_set WEB_HTTPS_PORT "$https"
    env_set S3_HTTPS_PORT "$s3"
    env_set KCHS_BASE_URL "https://$DOMAIN$port"
    env_set KCHS_API_URL "https://$DOMAIN$port/api"
    env_set S3_PUBLIC_ENDPOINT "https://$DOMAIN:$s3"
    env_set KCHS_STORAGE_ORIGIN "https://$DOMAIN:$s3"
    [[ -z "$EMAIL" ]] || env_set CADDY_EMAIL "$EMAIL"
  fi
}

upload_basemap() {
  local dir="$BASEMAP"
  if [[ -z "$dir" && -d "$ROOT/seeds/.cache/basemaps/out" ]]; then
    dir="$ROOT/seeds/.cache/basemaps/out"
  fi
  if [[ -z "$dir" ]]; then
    say "Подложки нет — карты откроются «без подложки». Сборка (нужен интернет, ~6 минут):"
    say "  KCHS_BASEMAP_UPLOAD=0 bash infra/basemaps/build-pmtiles.sh, затем снова up."
    return
  fi
  [[ -d "$dir" ]] || die "каталог подложки $dir не найден"
  say "── Подложка карты ($dir) ──"
  # compose cp сохраняет владельца файлов с хоста: убирает их root, а не пользователь api
  compose exec -T -u 0 api rm -rf /tmp/basemaps
  compose cp "$dir" api:/tmp/basemaps >/dev/null 2>&1 || die "подложка не скопировалась в контейнер api"
  compose exec -T api kchs basemaps upload /tmp/basemaps
  compose exec -T -u 0 api rm -rf /tmp/basemaps
}

cmd_up() {
  preflight
  prepare_env
  if [[ "${BUILD:-1}" == 1 ]]; then
    say "── Сборка образов (первый раз — 5–15 минут) ──"
    compose build
  fi
  say "── Запуск служб ──"
  compose up -d --wait --wait-timeout 900

  say "── Первичная настройка (kchs init) ──"
  local init temp email
  email="$(env_get KCHS_ADMIN_EMAIL)"
  init="$(compose exec -T api kchs init --admin-login admin --admin-email "${email:-admin@demo.local}")"
  temp="$(printf '%s\n' "$init" | sed -n 's/^ *Временный пароль: //p' | head -1)"
  # Сразу, а не в конце: если следующий шаг упадёт, одноразовый пароль не пропадёт
  if [[ -n "$temp" ]]; then
    say "Администратор: admin, временный пароль: $temp"
    say "  (показывается один раз — запишите; при первом входе система попросит задать свой)"
  fi

  say "── Демо-данные: оргструктура, документы, поручения, пакет ЧС, датасеты $DATA (3–6 минут) ──"
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/kchs-demo.XXXXXX")"
  if ! compose exec -T api kchs seed --data "$DATA" >"$log" 2>&1; then
    grep -viE 'парол|password' "$log" | tail -40 >&2
    rm -f "$log"
    die "демо-данные не загрузились (журнал выше)"
  fi
  rm -f "$log"
  upload_basemap

  say
  say "Стенд готов: $(env_get KCHS_BASE_URL)"
  if [[ -n "$temp" ]]; then
    say "Администратор: admin, временный пароль — выше, после kchs init"
  else
    say "Администратор: admin — пароль прежний (заведён раньше)."
  fi
  say "Демо-сотрудники: user001…user060, пароль — ключ SEED_USER_PASSWORD в $ENV_FILE"
  say "Сценарий показа: docs/06-guides/30-demo-stand.md"
}

cmd_reset() {
  [[ -f "$ENV_FILE" ]] || die "стенда нет — сначала up"
  say "── Сброс: данные стираются, окружение, пароли и сертификаты остаются ──"
  compose down --remove-orphans
  local volume
  for volume in "${DATA_VOLUMES[@]}"; do
    docker volume rm -f "${PROJECT}_$volume" >/dev/null 2>&1 || true
  done
  BUILD="${BUILD:-0}"
  cmd_up
}

cmd_status() {
  [[ -f "$ENV_FILE" ]] || die "стенда нет — сначала up"
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
  local url api
  url="$(env_get KCHS_BASE_URL)"
  api="$(env_get API_PORT)"
  say
  say "Адрес: $url"
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${api:-3000}/health"; then
    say "api: работает"
  else
    say "api: не отвечает — bash infra/scripts/demo-stand.sh logs api"
  fi
  say "Администратор: admin; демо-сотрудники: user001…user060, пароль — SEED_USER_PASSWORD в $ENV_FILE"
}

cmd_down() {
  [[ -f "$ENV_FILE" ]] || die "стенда нет"
  if [[ "$VOLUMES" == 1 ]]; then
    [[ "$YES" == 1 ]] || die "down --volumes стирает все данные и сертификаты — добавьте --yes"
    compose down -v --remove-orphans
  else
    compose down --remove-orphans
  fi
}

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift
DOMAIN=""
EMAIL=""
DATA="small"
BASEMAP=""
BUILD=""
VOLUMES=0
YES=0

case "$COMMAND" in
  up | reset | status | down)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --domain) DOMAIN="${2:?укажите домен}"; shift ;;
        --email) EMAIL="${2:?укажите почту}"; shift ;;
        --data) DATA="${2:?small или demo}"; shift ;;
        --basemap) BASEMAP="${2:?укажите каталог}"; shift ;;
        --no-build) BUILD=0 ;;
        --build) BUILD=1 ;;
        --volumes) VOLUMES=1 ;;
        --yes) YES=1 ;;
        *) die "неизвестный ключ $1" ;;
      esac
      shift
    done
    [[ "$DATA" == small || "$DATA" == demo ]] || die "--data: small или demo"
    "cmd_$COMMAND"
    ;;
  kchs) compose exec -T api kchs "$@" ;;
  logs) compose logs --tail=80 "$@" ;;
  *)
    # Справка — комментарий в начале файла
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 2
    ;;
esac
