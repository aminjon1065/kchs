#!/usr/bin/env bash
# Сторож рабочей установки (ADR-0227): без профиля наблюдаемости следит за самым важным и
# пишет в Telegram. Запускается таймером systemd каждые 5 минут (ставит pilot.sh install).
#
#   bash infra/scripts/watchdog.sh             # проверить и сообщить
#   bash infra/scripts/watchdog.sh --dry-run   # то же, но без отправки и перезапусков
#
# Проверки:
#   - диск: занято больше KCHS_WATCHDOG_DISK_PCT (85 %) — каталог Docker, копий, установки;
#   - контейнер проекта unhealthy — перезапускается и об этом сообщается; перезапуск по кругу
#     или остановленная служба — сообщение;
#   - копия: KCHS_BACKUP_DIR/last-success старше KCHS_WATCHDOG_BACKUP_HOURS (26 ч) или нет;
#   - api не отвечает на /health.
# Одно и то же сообщение — не чаще раза в час; когда беда прошла — «снова в порядке».
# Настройки — из .env установки (KCHS_PILOT_ENV_FILE, иначе .env в корне копии):
# TELEGRAM_BOT_TOKEN, KCHS_ALERT_TELEGRAM_CHAT (или ALERTMANAGER_TELEGRAM_CHAT_ID),
# TELEGRAM_API_URL, API_PORT, KCHS_PILOT_PROJECT, KCHS_BACKUP_DIR. Состояние — в
# KCHS_WATCHDOG_STATE (/var/lib/kchs-watchdog).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_PILOT_ENV_FILE:-$ROOT/.env}"
DRY_RUN=0
[[ "${1:-}" == --dry-run ]] && DRY_RUN=1

env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# Переменная окружения процесса важнее файла: так сторожа проверяют и запускают вручную
setting() {
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(env_get "$1")"
  printf '%s' "${value:-${2:-}}"
}

PROJECT="$(setting KCHS_PILOT_PROJECT kchs)"
TOKEN="$(setting TELEGRAM_BOT_TOKEN)"
CHAT="$(setting KCHS_ALERT_TELEGRAM_CHAT)"
[[ -n "$CHAT" ]] || CHAT="$(setting ALERTMANAGER_TELEGRAM_CHAT_ID)"
API_URL="$(setting TELEGRAM_API_URL https://api.telegram.org)"
API_PORT="$(setting API_PORT 3000)"
BACKUP_DIR="$(setting KCHS_BACKUP_DIR /var/lib/kchs-backup)"
DISK_PCT="$(setting KCHS_WATCHDOG_DISK_PCT 85)"
BACKUP_HOURS="$(setting KCHS_WATCHDOG_BACKUP_HOURS 26)"
STATE="$(setting KCHS_WATCHDOG_STATE /var/lib/kchs-watchdog)"
REPEAT_SECONDS="$(setting KCHS_WATCHDOG_REPEAT_SECONDS 3600)"
HOST="$(hostname -s 2>/dev/null || hostname)"
# Telegram из закрытого контура — через исходящий прокси установки (ADR-0132)
export HTTPS_PROXY="${HTTPS_PROXY:-$(env_get HTTPS_PROXY)}"
export HTTP_PROXY="${HTTP_PROXY:-$(env_get HTTP_PROXY)}"
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

send() {
  local text="kchs, $HOST: $1"
  if [[ "$DRY_RUN" == 1 ]]; then
    log "[dry-run] Telegram: $text"
    return 0
  fi
  if [[ -z "$TOKEN" || -z "$CHAT" ]]; then
    log "Telegram не настроен (TELEGRAM_BOT_TOKEN, KCHS_ALERT_TELEGRAM_CHAT): $text"
    return 1
  fi
  # Токен — в адресе запроса: в журнал адрес не пишется
  if curl -fsS -m 20 -o /dev/null -X POST "$API_URL/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$text"; then
    log "отправлено: $text"
  else
    log "не отправлено (Telegram недоступен): $text"
    return 1
  fi
}

# Беда с ключом: сообщение не чаще REPEAT_SECONDS; отметка — файл в STATE
alert() {
  local key="$1" text="$2" mark now
  mark="$STATE/$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')"
  SEEN="$SEEN $mark "
  now="$(date +%s)"
  if [[ -f "$mark" ]] && ((now - $(stat -c %Y "$mark" 2>/dev/null || stat -f %m "$mark") < REPEAT_SECONDS)); then
    return 0
  fi
  if send "⚠ $text"; then
    [[ "$DRY_RUN" == 1 ]] || printf '%s\n' "$text" >"$mark"
  fi
}

# Беды, которых в этом проходе не было, — прошли: сообщить и снять отметку
recovered() {
  local mark
  for mark in "$STATE"/*; do
    [[ -f "$mark" ]] || continue
    [[ "$SEEN" == *" $mark "* ]] && continue
    if send "✓ снова в порядке: $(cat "$mark")"; then
      [[ "$DRY_RUN" == 1 ]] || rm -f "$mark"
    fi
  done
}

epoch_of() {
  date -d "$1" +%s 2>/dev/null ||
    python3 -c 'import sys,datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$1" 2>/dev/null
}

check_disk() {
  local path pct mount seen_mounts=" "
  for path in "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" "$BACKUP_DIR" "$ROOT"; do
    [[ -n "$path" && -e "$path" ]] || continue
    read -r mount pct < <(df -P "$path" | awk 'NR == 2 { sub("%", "", $5); print $6, $5 }')
    [[ -n "$mount" && "$seen_mounts" != *" $mount "* ]] || continue
    seen_mounts="$seen_mounts$mount "
    if ((pct >= DISK_PCT)); then
      alert "disk:$mount" "диск $mount занят на $pct % (порог $DISK_PCT %) — места почти нет"
    fi
  done
}

# Разовые службы проекта завершаются сами — их остановка не беда
ONE_SHOT=" minio-init observability-init mail-init metrics-init-postgres metrics-init-minio metrics-init-meilisearch "

check_containers() {
  local name status service
  while IFS=$'\t' read -r name status service; do
    [[ -n "$name" ]] || continue
    case "$status" in
      *"(unhealthy)"*)
        if [[ "$DRY_RUN" == 1 ]]; then
          log "[dry-run] перезапуск $name"
        else
          docker restart "$name" >/dev/null 2>&1
        fi
        alert "unhealthy:$service" "служба $service не отвечала на проверку здоровья — перезапущена"
        ;;
      Restarting*)
        alert "restarting:$service" "служба $service падает и перезапускается по кругу — смотрите pilot.sh logs $service"
        ;;
      Exited* | Dead*)
        [[ "$ONE_SHOT" == *" $service "* ]] ||
          alert "stopped:$service" "служба $service остановлена ($status)"
        ;;
    esac
  done < <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null)
}

check_backup() {
  local file="$BACKUP_DIR/last-success" at age
  if [[ ! -f "$file" ]]; then
    alert "backup" "резервных копий ещё не было ($file) — настройте копии (docs/06-guides/27-admin-backup.md)"
    return
  fi
  at="$(tr -d '[:space:]' <"$file")"
  age="$(epoch_of "$at")"
  if [[ -z "$age" ]]; then
    alert "backup" "не прочитать время последней копии в $file: «$at»"
    return
  fi
  age=$((($(date +%s) - age) / 3600))
  if ((age >= BACKUP_HOURS)); then
    alert "backup" "последняя удачная копия — $age ч назад ($at), порог $BACKUP_HOURS ч"
  fi
}

check_health() {
  curl -fsS -m 10 -o /dev/null "http://127.0.0.1:$API_PORT/health" ||
    alert "health" "api не отвечает на /health — портал недоступен"
}

SEEN=" "
check_disk
check_containers
check_backup
check_health
recovered
exit 0
