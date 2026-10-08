#!/usr/bin/env bash
# Стенд демонстрации Комитету (ADR-0148): ноутбук владельца или арендованный VPS — одной
# командой. Всё в контейнерах (профиль app), демо-данные профиля small с пакетом ЧС,
# подложка карты, свои пароли демо-учёток. Руководство — docs/06-guides/30-demo-stand.md.
#
#   bash infra/scripts/demo-stand.sh up                      # ноутбук: http://localhost:8080
#   bash infra/scripts/demo-stand.sh up --empty              # без демо-данных: администратор,
#                                                            # территории и подложка
#   bash infra/scripts/demo-stand.sh up --domain demo.example.org --email you@example.org
#                                                            # VPS: HTTPS, сертификат Let's Encrypt
#   bash infra/scripts/demo-stand.sh reset [--build]         # перед показом: данные заново
#   bash infra/scripts/demo-stand.sh status                  # адрес, учётки, состояние служб
#   bash infra/scripts/demo-stand.sh history <каталог>       # история ЧС Комитета из каталога
#                                                            # infra/history/build-bundle.sh
#   bash infra/scripts/demo-stand.sh basemap [каталог]       # подложку заново (новая сборка,
#                                                            # рельеф, внешние из каталога) —
#                                                            # данные не трогает
#   bash infra/scripts/demo-stand.sh kchs <команда>          # kchs в контейнере api
#   bash infra/scripts/demo-stand.sh logs [служба…]          # последние строки журналов
#   bash infra/scripts/demo-stand.sh down [--volumes --yes]  # остановить (и стереть всё)
#
# Каталог подложки (--basemap) запоминается в .env стенда (KCHS_DEMO_BASEMAP) для сброса.
# Внешние подложки — спутник и топографическая (ADR-0196) — добавляются сами, стенду нужен
# интернет; без них — KCHS_DEMO_BASEMAP_PRESETS=none.
# Ключи up: --data small|demo|none (по умолчанию small; --empty — то же, что none: только
# администратор от kchs init и справочники — территории и базовые карты), --basemap КАТАЛОГ
# (по умолчанию seeds/.cache/basemaps/out, если он есть), --no-build (образы уже собраны).
# Выбор данных запоминается в .env стенда (KCHS_DEMO_DATA): reset без ключа повторяет его.
# reset берёт собранные образы; --build — пересобрать после git pull.
# Окружение стенда — .env в корне копии (другой путь — KCHS_DEMO_ENV_FILE), проект
# compose — kchs (KCHS_DEMO_PROJECT; заданный при up запоминается в .env стенда). Стенду
# рядом со стендом разработки на одном ноутбуке нужен свой проект: у разработки тоже kchs, и
# reset стёр бы её тома. Порты — переменными WEB_PORT, WEB_HTTPS_PORT, S3_HTTPS_PORT и
# остальными из generate-secrets.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_DEMO_ENV_FILE:-$ROOT/.env}"
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

# Проект compose: из окружения, иначе запомненный в .env стенда, иначе kchs
PROJECT="${KCHS_DEMO_PROJECT:-$(env_get KCHS_DEMO_PROJECT)}"
PROJECT="${PROJECT:-kchs}"

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
    # Секреты, появившиеся в новой версии (пользователи движка, ADR-0176), — к
    # прежним паролям, без их замены
    bash "$ROOT/infra/scripts/generate-secrets.sh" --add-missing --env-file "$ENV_FILE" >/dev/null
  else
    bash "$ROOT/infra/scripts/generate-secrets.sh" --mode app --env-file "$ENV_FILE" >/dev/null
    say "Создан $ENV_FILE со случайными секретами (права 600)"
  fi
  # Пароль демо-сотрудников — свой у каждого стенда: встроенный известен всем, кто видел код
  [[ -n "$(env_get SEED_USER_PASSWORD)" ]] || env_set SEED_USER_PASSWORD "$(demo_password)"
  [[ "$PROJECT" == kchs ]] || env_set KCHS_DEMO_PROJECT "$PROJECT"
  # Данные стенда: ключ up/reset, иначе выбранные раньше, иначе small
  DATA="${DATA:-$(env_get KCHS_DEMO_DATA)}"
  DATA="${DATA:-small}"
  env_set KCHS_DEMO_DATA "$DATA"
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
  # Каталог подложки, указанный раньше, запоминается: сброс стирает хранилище вместе с ней
  local dir="${BASEMAP:-$(env_get KCHS_DEMO_BASEMAP)}"
  [[ -n "$BASEMAP" ]] && env_set KCHS_DEMO_BASEMAP "$BASEMAP"
  if [[ -z "$dir" && -d "$ROOT/seeds/.cache/basemaps/out" ]]; then
    dir="$ROOT/seeds/.cache/basemaps/out"
  fi
  if [[ -z "$dir" ]]; then
    say "Подложки нет — карты откроются «без подложки». Сборка (нужен интернет, ~6 минут):"
    say "  KCHS_BASEMAP_UPLOAD=0 bash infra/basemaps/build-pmtiles.sh, затем снова up."
  else
    [[ -d "$dir" ]] || die "каталог подложки $dir не найден"
    say "── Подложка карты ($dir) ──"
    # compose cp сохраняет владельца файлов с хоста: убирает их root, а не пользователь api
    compose exec -T -u 0 api rm -rf /tmp/basemaps
    compose cp "$dir" api:/tmp/basemaps >/dev/null 2>&1 ||
      die "подложка не скопировалась в контейнер api"
    compose exec -T api kchs basemaps upload /tmp/basemaps
    compose exec -T -u 0 api rm -rf /tmp/basemaps
  fi
  add_presets
}

# Внешние подложки из каталога (ADR-0196): спутник с «Гибридом» и топографическая — стенду
# нужен интернет. KCHS_DEMO_BASEMAP_PRESETS — свой список ключей или none (без интернета).
add_presets() {
  local presets="${KCHS_DEMO_BASEMAP_PRESETS:-$(env_get KCHS_DEMO_BASEMAP_PRESETS)}"
  presets="${presets:-sentinel2 opentopomap}"
  [[ "$presets" == none ]] && return 0
  say "── Внешние подложки: $presets ──"
  local keys
  read -r -a keys <<<"$presets"
  compose exec -T api kchs basemaps add "${keys[@]}"
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

  local log seed_args
  if [[ "$DATA" == none ]]; then
    say "── Справочники: территории с границами и населением, базовые карты (без демо-данных) ──"
    seed_args=(--profile base)
  else
    say "── Демо-данные: оргструктура, документы, поручения, пакет ЧС, датасеты $DATA (3–6 минут) ──"
    seed_args=(--data "$DATA")
  fi
  log="$(mktemp "${TMPDIR:-/tmp}/kchs-demo.XXXXXX")"
  if ! compose exec -T api kchs seed "${seed_args[@]}" >"$log" 2>&1; then
    grep -viE 'парол|password' "$log" | tail -40 >&2
    rm -f "$log"
    die "данные стенда не загрузились (журнал выше)"
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
  if [[ "$DATA" == none ]]; then
    say "Демо-данных нет: оргструктуру, сотрудников и данные заводит администратор."
  else
    say "Демо-сотрудники: user001…user060, пароль — ключ SEED_USER_PASSWORD в $ENV_FILE"
    say "Сценарий показа: docs/06-guides/30-demo-stand.md"
  fi
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

# История ЧС Комитета (infra/history/README.md): каталог загрузки копируется в контейнер api и
# грузится командой kchs import-history; повторный запуск досоздаёт только недостающее
cmd_history() {
  local dir="${1:-}"
  [[ -f "$ENV_FILE" ]] || die "стенда нет — сначала up"
  [[ -n "$dir" && -f "$dir/manifest.json" ]] || die "укажите каталог загрузки с manifest.json (infra/history/build-bundle.sh)"
  say "── История ЧС ($dir) ──"
  compose exec -T -u 0 api rm -rf /tmp/history
  compose cp "$dir" api:/tmp/history >/dev/null 2>&1 || die "каталог не скопировался в контейнер api"
  compose exec -T api kchs import-history /tmp/history
  compose exec -T -u 0 api rm -rf /tmp/history
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
  if [[ "$(env_get KCHS_DEMO_DATA)" == none ]]; then
    say "Администратор: admin; демо-данных нет"
  else
    say "Администратор: admin; демо-сотрудники: user001…user060, пароль — SEED_USER_PASSWORD в $ENV_FILE"
  fi
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
DATA=""
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
        --data) DATA="${2:?small, demo или none}"; shift ;;
        --empty) DATA=none ;;
        --basemap) BASEMAP="${2:?укажите каталог}"; shift ;;
        --no-build) BUILD=0 ;;
        --build) BUILD=1 ;;
        --volumes) VOLUMES=1 ;;
        --yes) YES=1 ;;
        *) die "неизвестный ключ $1" ;;
      esac
      shift
    done
    [[ -z "$DATA" || "$DATA" == small || "$DATA" == demo || "$DATA" == none ]] ||
      die "--data: small, demo или none"
    "cmd_$COMMAND"
    ;;
  basemap)
    [[ -f "$ENV_FILE" ]] || die "стенда нет — сначала up"
    BASEMAP="${1:-}"
    upload_basemap
    ;;
  kchs) compose exec -T api kchs "$@" ;;
  history) cmd_history "$@" ;;
  logs) compose logs --tail=80 "$@" ;;
  *)
    # Справка — комментарий в начале файла
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 2
    ;;
esac
