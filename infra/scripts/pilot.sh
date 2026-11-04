#!/usr/bin/env bash
# Рабочая установка kchs — пилот на одном сервере с реальными данными (ADR-0227).
# В отличие от стенда показа (demo-stand.sh) скрипт никогда не стирает тома и не
# загружает демо-данные. Руководство — docs/06-guides/32-pilot-install.md.
#
#   sudo bash infra/scripts/pilot.sh install --domain portal.example.tj --email it@example.tj \
#        [--storage-domain files.portal.example.tj] [--profile 16|32] \
#        [--telegram-chat <id чата>] [--basemap <каталог>] [--office] [--no-build]
#                                            # первая установка: HTTPS, администратор,
#                                            # справочники и пакет ЧС, сторож
#   sudo bash infra/scripts/pilot.sh update [--skip-backup] [--no-build]
#                                            # копия, сборка, миграции, перезапуск
#   bash infra/scripts/pilot.sh status       # службы, копия, диск, сторож
#   bash infra/scripts/pilot.sh profile 16|32 # другой профиль памяти и процессора
#   sudo bash infra/scripts/pilot.sh watchdog-install   # сторож systemd заново
#   bash infra/scripts/pilot.sh history <каталог>       # история ЧС Комитета
#   bash infra/scripts/pilot.sh basemap [каталог]       # подложка карты заново
#   bash infra/scripts/pilot.sh kchs <команда>          # kchs в контейнере api
#   bash infra/scripts/pilot.sh logs [служба…]          # последние строки журналов
#
# Окружение — .env в корне копии (другой путь — KCHS_PILOT_ENV_FILE), проект compose —
# kchs (KCHS_PILOT_PROJECT). Хранилище файлов отдаётся на своём имени и порту 443
# (storage-subdomain.yml): прокси организации обычно пускает HTTPS только на 443.
# Профиль 16 или 32 — пределы памяти и процессора служб под сервер на 16 или 32 ГБ.
# --no-build — образы уже есть (собраны раньше или привезены `docker load` в закрытый
# контур): скрипт их не собирает.
# Порты — переменными WEB_PORT и WEB_HTTPS_PORT (по умолчанию 80 и 443) и остальными из
# generate-secrets.sh: так ставится временная проверочная установка рядом с другими.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_PILOT_ENV_FILE:-$ROOT/.env}"
BACKUP_SCRIPT="${KCHS_BACKUP_SCRIPT:-$ROOT/infra/scripts/backup.sh}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'Ошибка: %s\n' "$*" >&2
  exit 1
}

env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# Значения без обратной косой черты: адреса и пределы собирает сам скрипт
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/kchs-pilot.XXXXXX")"
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

PROJECT="${KCHS_PILOT_PROJECT:-$(env_get KCHS_PILOT_PROJECT)}"
PROJECT="${PROJECT:-kchs}"

compose() {
  local profiles=(--profile app)
  [[ "$(env_get KCHS_PILOT_OFFICE)" == 1 ]] && profiles+=(--profile office)
  [[ "$(env_get KCHS_PILOT_OBSERVABILITY)" == 1 ]] && profiles+=(--profile observability)
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/infra/compose/docker-compose.yml" \
    -f "$ROOT/infra/compose/storage-subdomain.yml" "${profiles[@]}" "$@"
}

require_pilot() {
  [[ -f "$ENV_FILE" ]] || die "установки нет — сначала install"
  [[ "$(env_get KCHS_INSTALL_KIND)" == pilot ]] ||
    die "$ENV_FILE — не рабочая установка (нет KCHS_INSTALL_KIND=pilot). Стенд показа — demo-stand.sh."
}

# Ядра, доступные Docker: пределы процессора не должны быть больше, иначе Docker не
# запустит контейнер (на macOS и Windows у виртуальной машины Docker ядер меньше)
host_cpus() {
  local cpus
  cpus="$(docker info --format '{{.NCPU}}' 2>/dev/null || true)"
  [[ "$cpus" =~ ^[0-9]+$ ]] || cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  printf '%s' "$cpus"
}

# Профиль из ключа, иначе запомненный в .env, иначе 16 — сервер ещё не выбран
current_profile() {
  local profile="${PROFILE:-$(env_get KCHS_PILOT_PROFILE)}"
  printf '%s' "${profile:-16}"
}

cap_cpus() {
  local want="$1" have
  have="$(host_cpus)"
  if ((want > have)); then printf '%s' "$have"; else printf '%s' "$want"; fi
}

# Пределы памяти и процессора по профилю сервера (ADR-0227). Предел — потолок, а не
# резерв: обычно службы берут меньше. Postgres без предела — его защищает oom_score_adj
apply_profile() {
  local profile="$1"
  case "$profile" in
    16)
      env_set API_MEM_LIMIT 2g
      env_set WORKER_MEM_LIMIT 2g
      env_set ENGINE_MEM_LIMIT 4g
      env_set ENGINE_CONCURRENCY 2
      env_set ENGINE_COLUMNAR_MEMORY_MB 1024
      env_set MEILI_MEM_LIMIT 2g
      env_set MEILI_MAX_INDEXING_MEMORY 1073741824
      env_set ONLYOFFICE_MEM_LIMIT 3g
      env_set WEB_MEM_LIMIT 512m
      env_set POSTGRES_SHARED_BUFFERS 1GB
      env_set POSTGRES_EFFECTIVE_CACHE_SIZE 4GB
      env_set PROMETHEUS_MEM_LIMIT 1g
      env_set LOKI_MEM_LIMIT 1g
      env_set TEMPO_MEM_LIMIT 768m
      env_set GRAFANA_MEM_LIMIT 512m
      env_set ALLOY_MEM_LIMIT 512m
      env_set ALERTMANAGER_MEM_LIMIT 256m
      env_set API_CPUS "$(cap_cpus 2)"
      env_set WORKER_CPUS "$(cap_cpus 2)"
      env_set ENGINE_CPUS "$(cap_cpus 2)"
      env_set MEILI_CPUS "$(cap_cpus 2)"
      env_set ONLYOFFICE_CPUS "$(cap_cpus 2)"
      ;;
    32)
      env_set API_MEM_LIMIT 3g
      env_set WORKER_MEM_LIMIT 3g
      env_set ENGINE_MEM_LIMIT 8g
      env_set ENGINE_CONCURRENCY 4
      env_set ENGINE_COLUMNAR_MEMORY_MB 3072
      env_set MEILI_MEM_LIMIT 4g
      env_set MEILI_MAX_INDEXING_MEMORY 2147483648
      env_set ONLYOFFICE_MEM_LIMIT 4g
      env_set WEB_MEM_LIMIT 512m
      env_set POSTGRES_SHARED_BUFFERS 4GB
      env_set POSTGRES_EFFECTIVE_CACHE_SIZE 12GB
      env_set PROMETHEUS_MEM_LIMIT 2g
      env_set LOKI_MEM_LIMIT 2g
      env_set TEMPO_MEM_LIMIT 1536m
      env_set GRAFANA_MEM_LIMIT 512m
      env_set ALLOY_MEM_LIMIT 512m
      env_set ALERTMANAGER_MEM_LIMIT 256m
      env_set API_CPUS "$(cap_cpus 4)"
      env_set WORKER_CPUS "$(cap_cpus 4)"
      env_set ENGINE_CPUS "$(cap_cpus 4)"
      env_set MEILI_CPUS "$(cap_cpus 2)"
      env_set ONLYOFFICE_CPUS "$(cap_cpus 4)"
      ;;
    *) die "профиль — 16 или 32 (ГБ памяти сервера)" ;;
  esac
  env_set KCHS_PILOT_PROFILE "$profile"
}

preflight() {
  command -v docker >/dev/null || die "нужен Docker 27+ с Compose v2 — https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Docker не запущен (или нужен sudo)"
  docker compose version >/dev/null 2>&1 || die "нужен Docker Compose v2"
  command -v openssl >/dev/null || die "нужен openssl"
  command -v curl >/dev/null || die "нужен curl"
  local mem want
  mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  want="$(current_profile)"
  if ((mem > 0 && mem < want * 1000000000 * 9 / 10)); then
    say "Внимание: Docker доступно $((mem / 1073741824)) ГБ памяти, а профиль рассчитан на $want ГБ."
    if [[ "$want" == 32 ]]; then
      say "Выберите --profile 16 или сервер побольше; без своп-файла 4–8 ГБ возможны падения."
    else
      say "Серверу нужно 16 ГБ; на меньшем возможны падения служб, своп-файл 4–8 ГБ обязателен."
    fi
  fi
  local free
  free="$(df -Pk "$ROOT" | awk 'NR == 2 { print int($4 / 1048576) }')"
  if ((free < 50)); then
    say "Внимание: свободно $free ГБ на диске, рабочей установке нужно не меньше 50 ГБ (лучше 150+)."
  fi
}

prepare_env() {
  if [[ -f "$ENV_FILE" ]]; then
    [[ "$(env_get NODE_ENV)" == production ]] ||
      die "$ENV_FILE — окружение стенда разработки. Рабочую установку ставьте на сервере или с KCHS_PILOT_ENV_FILE=<другой путь>."
    local demo
    demo="$(env_get KCHS_DEMO_DATA)"
    [[ -z "$demo" || "$demo" == none || "$(env_get KCHS_INSTALL_KIND)" == pilot ]] ||
      die "$ENV_FILE — стенд показа с демо-данными ($demo): у него общие учётки демо-мира. Рабочую установку ставьте на чистый сервер."
    bash "$ROOT/infra/scripts/generate-secrets.sh" --add-missing --env-file "$ENV_FILE" >/dev/null
  else
    bash "$ROOT/infra/scripts/generate-secrets.sh" --mode app --env-file "$ENV_FILE" >/dev/null
    say "Создан $ENV_FILE со случайными секретами (права 600). Храните его копию отдельно от сервера."
  fi
  env_set KCHS_INSTALL_KIND pilot
  [[ "$PROJECT" == kchs ]] || env_set KCHS_PILOT_PROJECT "$PROJECT"

  local https="${WEB_HTTPS_PORT:-443}" port=""
  [[ "$https" == 443 ]] || port=":$https"
  local storage="${STORAGE_DOMAIN:-files.$DOMAIN}"
  env_set KCHS_DOMAIN "$DOMAIN"
  env_set KCHS_STORAGE_DOMAIN "$storage"
  env_set WEB_PORT "${WEB_PORT:-80}"
  env_set WEB_HTTPS_PORT "$https"
  env_set KCHS_BASE_URL "https://$DOMAIN$port"
  env_set KCHS_API_URL "https://$DOMAIN$port/api"
  env_set S3_PUBLIC_ENDPOINT "https://$storage$port"
  env_set KCHS_STORAGE_ORIGIN "https://$storage$port"
  env_set CADDY_EMAIL "$EMAIL"
  env_set KCHS_ADMIN_EMAIL "$EMAIL"
  # Поиск — в рабочем режиме (ADR-0227): установки до этой версии были в development
  env_set MEILI_ENV production
  [[ -z "$TELEGRAM_CHAT" ]] || env_set KCHS_ALERT_TELEGRAM_CHAT "$TELEGRAM_CHAT"
  [[ "$OFFICE" != 1 ]] || env_set KCHS_PILOT_OFFICE 1
  apply_profile "$(current_profile)"
}

upload_basemap() {
  local dir="${BASEMAP:-$(env_get KCHS_PILOT_BASEMAP)}"
  [[ -n "$BASEMAP" ]] && env_set KCHS_PILOT_BASEMAP "$BASEMAP"
  if [[ -z "$dir" && -d "$ROOT/seeds/.cache/basemaps/out" ]]; then
    dir="$ROOT/seeds/.cache/basemaps/out"
  fi
  if [[ -z "$dir" ]]; then
    say "Подложки района нет — карты откроются со внешними подложками. Сборка (нужен интернет):"
    say "  KCHS_BASEMAP_UPLOAD=0 bash infra/basemaps/build-pmtiles.sh, затем pilot.sh basemap."
  else
    [[ -d "$dir" ]] || die "каталог подложки $dir не найден"
    say "── Подложка карты ($dir) ──"
    compose exec -T -u 0 api rm -rf /tmp/basemaps
    compose cp "$dir" api:/tmp/basemaps >/dev/null 2>&1 || die "подложка не скопировалась в контейнер api"
    compose exec -T api kchs basemaps upload /tmp/basemaps
    compose exec -T -u 0 api rm -rf /tmp/basemaps
  fi
  # Внешние подложки из каталога (ADR-0196): спутник и топографическая — серверу нужен
  # интернет; KCHS_PILOT_BASEMAP_PRESETS=none — без них
  local presets="${KCHS_PILOT_BASEMAP_PRESETS:-$(env_get KCHS_PILOT_BASEMAP_PRESETS)}"
  presets="${presets:-sentinel2 opentopomap}"
  if [[ "$presets" != none ]]; then
    local keys
    read -r -a keys <<<"$presets"
    compose exec -T api kchs basemaps add "${keys[@]}" || say "Внешние подложки не добавились — нет интернета? Позже: pilot.sh kchs basemaps add ${presets}"
  fi
}

health_check() {
  local api_port="${API_PORT:-$(env_get API_PORT)}"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${api_port:-3000}/health"; then
      say "api: работает"
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_watchdog_install() {
  require_pilot
  if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
    say "systemd нет — сторож не установлен. Запускайте каждые 5 минут вручную или cron:"
    say "  */5 * * * * KCHS_PILOT_ENV_FILE=$ENV_FILE bash $ROOT/infra/scripts/watchdog.sh"
    return 0
  fi
  [[ "$(id -u)" == 0 ]] || die "установка сторожа — с sudo"
  local unit
  for unit in kchs-watchdog.service kchs-watchdog.timer; do
    sed -e "s#@ROOT@#$ROOT#g" -e "s#@ENV_FILE@#$ENV_FILE#g" -e "s#@PROJECT@#$PROJECT#g" \
      "$ROOT/infra/systemd/$unit" >"/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable --now kchs-watchdog.timer >/dev/null
  say "Сторож: каждые 5 минут (systemctl status kchs-watchdog.timer)"
  if [[ -z "$(env_get KCHS_ALERT_TELEGRAM_CHAT)$(env_get ALERTMANAGER_TELEGRAM_CHAT_ID)" ||
    -z "$(env_get TELEGRAM_BOT_TOKEN)" ]]; then
    say "  Telegram не настроен: задайте TELEGRAM_BOT_TOKEN и KCHS_ALERT_TELEGRAM_CHAT в $ENV_FILE —"
    say "  до этого сторож пишет только в журнал (journalctl -u kchs-watchdog)."
  fi
}

cmd_install() {
  [[ -n "$DOMAIN" ]] || die "укажите --domain <имя портала>"
  [[ -n "$EMAIL" ]] || die "укажите --email <почта администратора> — для сертификата и учётки"
  preflight
  prepare_env
  if [[ "$BUILD" != 0 ]]; then
    say "── Сборка образов (первый раз — 10–20 минут) ──"
    compose build
  fi
  say "── Запуск служб ──"
  compose up -d --wait --wait-timeout 900

  say "── Первичная настройка (kchs init) ──"
  local init temp
  init="$(compose exec -T api kchs init --admin-login admin --admin-email "$EMAIL")"
  temp="$(printf '%s\n' "$init" | sed -n 's/^ *Временный пароль: //p' | head -1)"
  if [[ -n "$temp" ]]; then
    say "Администратор: admin, временный пароль: $temp"
    say "  (показывается один раз — запишите; при входе система попросит свой пароль и второй фактор)"
  fi

  # Справочники (территории с границами, базовые карты) и пакет ЧС — один раз, только в
  # пустую базу, которой kchs init только что завёл администратора: на базе с данными
  # seed заново вставил бы оргструктуру и должности (ADR-0227)
  if [[ -n "$temp" && -z "$(env_get KCHS_PILOT_REFERENCES)" ]]; then
    say "── Справочники и пакет ЧС (без демо-данных) ──"
    local log
    log="$(mktemp "${TMPDIR:-/tmp}/kchs-pilot.XXXXXX")"
    if ! compose exec -T api kchs seed --profile base --pack emergency >"$log" 2>&1; then
      grep -viE 'парол|password' "$log" | tail -40 >&2
      rm -f "$log"
      die "справочники не загрузились (журнал выше)"
    fi
    rm -f "$log"
    env_set KCHS_PILOT_REFERENCES "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    say "Справочники уже есть — не трогаю."
  fi
  upload_basemap
  cmd_watchdog_install

  say
  say "Установка готова: $(env_get KCHS_BASE_URL)"
  say "Файлы — $(env_get S3_PUBLIC_ENDPOINT): оба имени должны указывать на этот сервер (DNS)."
  [[ -n "$temp" ]] || say "Администратор: admin — пароль прежний (заведён раньше)."
  [[ -f "$BACKUP_SCRIPT" ]] || say "Резервные копии ещё не настроены: docs/06-guides/27-admin-backup.md."
}

cmd_update() {
  require_pilot
  preflight
  say "── Версия: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') ──"
  if [[ -f "$BACKUP_SCRIPT" ]]; then
    say "── Резервная копия перед обновлением ──"
    bash "$BACKUP_SCRIPT" run || die "копия не сделана — обновление остановлено. Причина — выше; без копии — --skip-backup (не советую)"
  elif [[ "$SKIP_BACKUP" == 1 ]]; then
    say "Внимание: обновление без свежей копии (--skip-backup)."
  else
    die "нет скрипта копий $BACKUP_SCRIPT — обновление без свежей копии только с --skip-backup"
  fi
  # Секреты и переменные новой версии — к прежним, без их замены
  bash "$ROOT/infra/scripts/generate-secrets.sh" --add-missing --env-file "$ENV_FILE" >/dev/null
  apply_profile "$(current_profile)"
  if [[ "$BUILD" != 0 ]]; then
    say "── Сборка образов ──"
    compose build
  fi
  say "── Перезапуск служб (миграции применяет api при старте) ──"
  compose up -d --wait --wait-timeout 900 --remove-orphans
  compose exec -T api kchs migrate >/dev/null
  health_check || die "api не отвечает после обновления — pilot.sh logs api"
  # Кэш сборки растёт с каждой версией: старше недели — убрать, неиспользуемые образы тоже
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  say "Обновление готово: $(env_get KCHS_BASE_URL)"
}

cmd_status() {
  require_pilot
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
  say
  say "Адрес: $(env_get KCHS_BASE_URL), файлы: $(env_get S3_PUBLIC_ENDPOINT)"
  say "Профиль: $(env_get KCHS_PILOT_PROFILE) ГБ"
  health_check >/dev/null && say "api: работает" || say "api: не отвечает — pilot.sh logs api"
  local backup_dir="${KCHS_BACKUP_DIR:-$(env_get KCHS_BACKUP_DIR)}"
  backup_dir="${backup_dir:-/var/lib/kchs-backup}"
  if [[ -f "$backup_dir/last-success" ]]; then
    say "Последняя копия: $(cat "$backup_dir/last-success")"
  else
    say "Копий ещё нет ($backup_dir/last-success)"
  fi
  df -Ph "$ROOT" | awk 'NR == 2 { print "Диск: занято " $5 ", свободно " $4 }'
  if command -v systemctl >/dev/null && systemctl list-timers kchs-watchdog.timer >/dev/null 2>&1; then
    systemctl is-active --quiet kchs-watchdog.timer && say "Сторож: работает" || say "Сторож: не запущен"
  fi
}

cmd_profile() {
  require_pilot
  PROFILE="${1:-}"
  apply_profile "$PROFILE"
  compose up -d --wait --wait-timeout 900
  say "Профиль $PROFILE ГБ применён"
}

cmd_history() {
  require_pilot
  local dir="${1:-}"
  [[ -n "$dir" && -f "$dir/manifest.json" ]] || die "укажите каталог загрузки с manifest.json (infra/history/build-bundle.sh)"
  say "── История ЧС ($dir) ──"
  compose exec -T -u 0 api rm -rf /tmp/history
  compose cp "$dir" api:/tmp/history >/dev/null 2>&1 || die "каталог не скопировался в контейнер api"
  compose exec -T api kchs import-history /tmp/history
  compose exec -T -u 0 api rm -rf /tmp/history
}

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift
DOMAIN=""
EMAIL=""
STORAGE_DOMAIN=""
PROFILE=""
TELEGRAM_CHAT=""
BASEMAP=""
OFFICE=0
SKIP_BACKUP=0
BUILD=1

case "$COMMAND" in
  install | update)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --domain) DOMAIN="${2:?укажите домен}"; shift ;;
        --email) EMAIL="${2:?укажите почту}"; shift ;;
        --storage-domain) STORAGE_DOMAIN="${2:?укажите имя хранилища}"; shift ;;
        --profile) PROFILE="${2:?16 или 32}"; shift ;;
        --telegram-chat) TELEGRAM_CHAT="${2:?укажите id чата}"; shift ;;
        --basemap) BASEMAP="${2:?укажите каталог}"; shift ;;
        --office) OFFICE=1 ;;
        --skip-backup) SKIP_BACKUP=1 ;;
        --no-build) BUILD=0 ;;
        *) die "неизвестный ключ $1" ;;
      esac
      shift
    done
    [[ -z "$PROFILE" || "$PROFILE" == 16 || "$PROFILE" == 32 ]] || die "--profile: 16 или 32"
    "cmd_$COMMAND"
    ;;
  status) cmd_status ;;
  profile) cmd_profile "$@" ;;
  watchdog-install) cmd_watchdog_install ;;
  history) cmd_history "$@" ;;
  basemap)
    require_pilot
    BASEMAP="${1:-}"
    upload_basemap
    ;;
  kchs) require_pilot; compose exec -T api kchs "$@" ;;
  logs) require_pilot; compose logs --tail=80 "$@" ;;
  *)
    # Справка — комментарий в начале файла
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 2
    ;;
esac
