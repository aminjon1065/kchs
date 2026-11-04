#!/usr/bin/env bash
# Забор копий установки на компьютер Комитета (ADR-0227). Сервер доступа к этой машине
# не имеет: она сама раз в сутки забирает зашифрованный репозиторий restic по SSH, только
# на чтение (на сервере — `backup.sh allow-pull`). Linux или WSL в Windows; руководство —
# docs/06-guides/27-admin-backup.md, раздел «Забор копий в Комитет».
#
#   bash backup-pull.sh pull     # забрать свежую копию (прежние поколения остаются)
#   bash backup-pull.sh verify   # целостность забранного без пароля (имя файла = SHA-256)
#   bash backup-pull.sh check    # полная проверка restic (нужен пароль репозитория)
#   bash backup-pull.sh status   # поколения и дата последнего забора
#
# Настройки — переменными окружения (удобно в ~/.config/kchs-backup-pull.env, его читает
# скрипт):
#   KCHS_PULL_HOST   адрес сервера (обязательно)
#   KCHS_PULL_USER   пользователь забора на сервере (kchs-backup)
#   KCHS_PULL_KEY    закрытый ключ SSH (~/.ssh/kchs-backup)
#   KCHS_PULL_DEST   куда складывать (~/kchs-backup): current/ — последняя копия,
#                    generations/ДАТА — прежние поколения (жёсткие ссылки: место почти
#                    не занимают)
#   KCHS_PULL_KEEP   сколько поколений хранить (14)
#   KCHS_PULL_PASSWORD_FILE  файл пароля репозитория — только для check
set -euo pipefail
CONF="${KCHS_PULL_CONFIG:-$HOME/.config/kchs-backup-pull.env}"
# shellcheck disable=SC1090
[[ -f "$CONF" ]] && . "$CONF"
HOST="${KCHS_PULL_HOST:-}"
USER_NAME="${KCHS_PULL_USER:-kchs-backup}"
KEY="${KCHS_PULL_KEY:-$HOME/.ssh/kchs-backup}"
DEST="${KCHS_PULL_DEST:-$HOME/kchs-backup}"
KEEP="${KCHS_PULL_KEEP:-14}"
PASS_FILE="${KCHS_PULL_PASSWORD_FILE:-}"
RESTIC_IMAGE="${KCHS_RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'backup-pull: %s\n' "$*" >&2
  exit 1
}

cmd_pull() {
  [[ -n "$HOST" ]] || die "задайте KCHS_PULL_HOST (адрес сервера) в $CONF"
  [[ -f "$KEY" ]] || die "нет ключа SSH $KEY (KCHS_PULL_KEY)"
  mkdir -p "$DEST/current" "$DEST/generations"
  # Прежняя копия — поколением из жёстких ссылок: если на сервере файлы удалят или
  # испортят, следующий забор не унесёт с собой последнюю хорошую копию
  local stamp
  stamp="$(date +%Y-%m-%d_%H%M%S)"
  if [[ -f "$DEST/current/config" ]]; then
    cp -al "$DEST/current" "$DEST/generations/$stamp"
  fi
  # Путь на сервере — корень, открытый rrsync (каталог репозитория). Замки restic не
  # нужны; файлы данных неизменяемы — новые докачиваются, удалённые очисткой уходят
  rsync -a --delete-delay --partial --exclude 'locks/' \
    -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
    "$USER_NAME@$HOST:/" "$DEST/current/"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$DEST/last-pull"
  # Лишние поколения — самые старые
  local count oldest
  count="$(ls -1 "$DEST/generations" | wc -l | tr -d ' ')"
  while [[ "$count" -gt "$KEEP" ]]; do
    oldest="$(ls -1 "$DEST/generations" | sort | head -1)"
    rm -rf -- "${DEST:?}/generations/${oldest:?}"
    count=$((count - 1))
  done
  say "Копия забрана: $DEST/current (поколений: $count)"
}

# Файлы репозитория restic называются SHA-256 своего содержимого (кроме config): забранную
# копию можно сверить без пароля — это ловит обрыв и порчу при передаче и на диске
cmd_verify() {
  local repo="${1:-$DEST/current}" bad=0 total=0 file name sum
  [[ -f "$repo/config" ]] || die "нет копии в $repo"
  while IFS= read -r -d '' file; do
    name="$(basename "$file")"
    sum="$(sha256sum "$file" | cut -d' ' -f1)"
    total=$((total + 1))
    if [[ "$sum" != "$name" ]]; then
      say "испорчен: ${file#"$repo"/}"
      bad=$((bad + 1))
    fi
  done < <(find "$repo/data" "$repo/index" "$repo/snapshots" "$repo/keys" -type f -print0)
  [[ "$bad" == 0 ]] || die "испорчено файлов: $bad из $total"
  say "Копия цела: $total файлов сверено ($repo)"
}

cmd_check() {
  local repo="${1:-$DEST/current}"
  [[ -f "$PASS_FILE" ]] || die "для check нужен пароль: KCHS_PULL_PASSWORD_FILE=<файл>"
  [[ -f "$repo/config" ]] || die "нет копии в $repo"
  # Своя копия забранного: restic пишет в репозиторий замок и кэш, а текущую копию
  # перезапишет следующий забор
  docker run --rm --network none -v "$repo:/repo:ro" -v "$PASS_FILE:/run/restic-pass:ro" \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-pass "$RESTIC_IMAGE" \
    --no-lock --no-cache check --read-data
  docker run --rm --network none -v "$repo:/repo:ro" -v "$PASS_FILE:/run/restic-pass:ro" \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-pass "$RESTIC_IMAGE" \
    --no-lock --no-cache snapshots --compact
}

cmd_status() {
  [[ -f "$DEST/last-pull" ]] && say "Последний забор: $(cat "$DEST/last-pull")"
  say "Поколения:"
  ls -1 "$DEST/generations" 2>/dev/null | sed 's/^/  /' || true
  du -sh "$DEST" 2>/dev/null | sed 's/^/Занято: /' || true
}

case "${1:-}" in
  pull) cmd_pull ;;
  verify) shift; cmd_verify "$@" ;;
  check) shift; cmd_check "$@" ;;
  status) cmd_status ;;
  *) die "команда: pull | verify [каталог] | check [каталог] | status" ;;
esac
