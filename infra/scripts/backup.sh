#!/usr/bin/env bash
# Резервные копии установки за пределы сервера (ADR-0227). Каждую ночь — зашифрованный
# репозиторий restic в каталоге хоста (вне томов Docker: `down -v` его не трогает):
# окружение (.env с мастер-ключом), дамп базы, файлы хранилища. Компьютер в Комитете
# забирает репозиторий по SSH только на чтение (backup-pull.sh) — у сервера доступа к
# машине Комитета нет. Руководство — docs/06-guides/27-admin-backup.md.
#
#   sudo bash infra/scripts/backup.sh init                 # репозиторий и пароль (один раз)
#   sudo bash infra/scripts/backup.sh run                  # копия: окружение, база, файлы
#   sudo bash infra/scripts/backup.sh status               # копии и признаки последнего прогона
#   sudo bash infra/scripts/backup.sh check [--read-data]  # целостность репозитория
#   sudo bash infra/scripts/backup.sh allow-pull <ключ.pub> # доступ компьютеру Комитета
#   sudo bash infra/scripts/backup.sh install-timer        # каждую ночь в 03:30 (systemd)
#   sudo bash infra/scripts/backup.sh restore [--repo КАТАЛОГ] [--snapshot ID] --yes
#                                                          # восстановление на чистую установку
#
# Настройки — переменными окружения или строками .env установки:
#   KCHS_BACKUP_DIR            каталог копий (по умолчанию /var/lib/kchs-backup): repo/ —
#                              репозиторий, cache/ — кэш restic, last-success и last-failure
#   KCHS_BACKUP_PASSWORD_FILE  файл пароля репозитория (по умолчанию /etc/kchs/backup.pass).
#                              Пароль НЕ хранится в .env: копия .env лежит в репозитории, и
#                              пароль внутри неё ничего бы не защищал
#   KCHS_BACKUP_KEEP_DAILY / _WEEKLY / _MONTHLY   хранение: 14 / 8 / 6
#   KCHS_BACKUP_GROUP          группа с чтением репозитория (по умолчанию kchs-backup, если
#                              она есть: её заводит allow-pull)
#   KCHS_COMPOSE_PROJECT       проект compose (по умолчанию KCHS_DEMO_PROJECT из .env или kchs)
#   KCHS_ENV_FILE              окружение установки (по умолчанию .env в корне копии)
#
# Что не копируется и почему: превью (kchs-previews) движок строит заново, выгрузки
# (kchs-exports) живут 30 дней и пересоздаются, колоночные копии (kchs-columnar) строятся
# из базы, копии pg_dump самой платформы (kchs-backups) повторяют снимок базы отсюда,
# поиск перестраивается из базы, Redis — очереди и кэш.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_ENV_FILE:-$ROOT/.env}"

# restic в контейнере: на сервере ставить ничего не нужно; образ закреплён по отпечатку
RESTIC_IMAGE="${KCHS_RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
# Имя узла в снимках: по нему restic группирует хранение, а сервер может смениться
SNAPSHOT_HOST=kchs

say() { printf '%s\n' "$*"; }
die() {
  printf 'backup: %s\n' "$*" >&2
  exit 1
}
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
setting() {
  # Переменная окружения, иначе строка .env, иначе значение по умолчанию
  local name="$1" fallback="$2" value
  value="${!name:-}"
  [[ -n "$value" ]] || value="$(env_get "$name")"
  printf '%s' "${value:-$fallback}"
}

BACKUP_DIR="$(setting KCHS_BACKUP_DIR /var/lib/kchs-backup)"
REPO="$BACKUP_DIR/repo"
PASS_FILE="$(setting KCHS_BACKUP_PASSWORD_FILE /etc/kchs/backup.pass)"
KEEP_DAILY="$(setting KCHS_BACKUP_KEEP_DAILY 14)"
KEEP_WEEKLY="$(setting KCHS_BACKUP_KEEP_WEEKLY 8)"
KEEP_MONTHLY="$(setting KCHS_BACKUP_KEEP_MONTHLY 6)"
GROUP="$(setting KCHS_BACKUP_GROUP kchs-backup)"
# Рабочая установка (pilot.sh) задаёт KCHS_PILOT_PROJECT, стенд показа — KCHS_DEMO_PROJECT
PROJECT="$(setting KCHS_COMPOSE_PROJECT "$(env_get KCHS_PILOT_PROJECT)")"
PROJECT="${PROJECT:-$(env_get KCHS_DEMO_PROJECT)}"
PROJECT="${PROJECT:-kchs}"
DB_NAME="$(env_get POSTGRES_DB)"
DB_NAME="${DB_NAME:-kchs}"
# Бакеты, без которых установку не восстановить: файлы сотрудников, записи встреч и
# фото, подложки карт
BUCKETS=("$(setting S3_BUCKET_FILES kchs-files)" "$(setting S3_BUCKET_MEDIA kchs-media)"
  "$(setting S3_BUCKET_TILES kchs-tiles)")
MINIO_VOLUME="${PROJECT}_miniodata"

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/infra/compose/docker-compose.yml" "$@"
}

# restic без сети: репозиторий локальный. Дополнительные тома — до образа
restic_() {
  local mounts=()
  while [[ $# -gt 0 && "$1" == -v ]]; do
    mounts+=("$1" "$2")
    shift 2
  done
  mkdir -p "$BACKUP_DIR/cache"
  docker run --rm -i --network none --hostname "$SNAPSHOT_HOST" \
    -v "$REPO:/repo" -v "$BACKUP_DIR/cache:/cache" -v "$PASS_FILE:/run/restic-pass:ro" \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-pass -e RESTIC_CACHE_DIR=/cache \
    ${mounts[@]+"${mounts[@]}"} "$RESTIC_IMAGE" "$@"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

need_repo() {
  [[ -f "$PASS_FILE" ]] || die "нет файла пароля $PASS_FILE — сначала init (или KCHS_BACKUP_PASSWORD_FILE)"
  [[ -f "$REPO/config" ]] || die "нет репозитория в $REPO — сначала init (или KCHS_BACKUP_DIR)"
}

cmd_init() {
  mkdir -p "$BACKUP_DIR" "$(dirname "$PASS_FILE")"
  chmod 750 "$BACKUP_DIR"
  if [[ ! -f "$PASS_FILE" ]]; then
    (umask 077 && openssl rand -base64 32 | tr -d '\n' >"$PASS_FILE")
    say "Пароль репозитория создан: $PASS_FILE"
    say "Перепишите его и храните ОФЛАЙН вместе с копией .env (сейф, бумага, флешка):"
    say "без пароля копии не расшифровать, а на сервере он может пропасть вместе с сервером."
    say ""
    say "    $(cat "$PASS_FILE")"
    say ""
  fi
  if [[ -f "$REPO/config" ]]; then
    say "Репозиторий уже есть: $REPO"
  else
    mkdir -p "$REPO"
    restic_ init --repository-version 2 >/dev/null
    say "Репозиторий создан: $REPO"
  fi
  share_repo
}

# Чтение репозитория группе забора (allow-pull): restic пишет файлы только владельцу
share_repo() {
  getent group "$GROUP" >/dev/null 2>&1 || return 0
  chgrp -R "$GROUP" "$REPO"
  chmod -R g+rX "$REPO"
  chmod 750 "$BACKUP_DIR"
  chgrp "$GROUP" "$BACKUP_DIR"
}

failure() {
  local reason="$1"
  printf '%s %s\n' "$(now_iso)" "$reason" >"$BACKUP_DIR/last-failure"
  die "$reason"
}

# Номер снимка из вывода `backup --json`: строка итога несёт snapshot_id
snapshot_id_of() { sed -n 's/.*"snapshot_id":"\([0-9a-f]*\)".*/\1/p' | tail -1; }

# Снимок целиком или никакого: restic сохраняет снимок и тогда, когда часть файлов не
# прочиталась (код 3), — такой снимок удаляется, чтобы каждый снимок в репозитории был
# полным. Аргументы — ключи `restic backup` (тома -v — первыми, как у restic_)
snapshot() {
  local out id status=0
  out="$(mktemp "${TMPDIR:-/tmp}/kchs-backup.XXXXXX")"
  restic_ "$@" --host "$SNAPSHOT_HOST" --json >"$out" || status=$?
  id="$(snapshot_id_of <"$out")"
  rm -f "$out"
  if [[ "$status" != 0 ]]; then
    [[ -n "$id" ]] && restic_ forget "$id" >/dev/null 2>&1
    return 1
  fi
}

backup_env() {
  [[ -f "$ENV_FILE" ]] || failure "нет окружения установки $ENV_FILE"
  # Потоком, а не монтированием файла: так одинаково на сервере и в Docker Desktop
  snapshot backup --tag env --stdin --stdin-filename kchs.env <"$ENV_FILE" ||
    failure "копия окружения не сделана"
}

backup_db() {
  local out id status
  out="$(mktemp "${TMPDIR:-/tmp}/kchs-backup.XXXXXX")"
  # Дамп суперпользователем вместе с владельцами, правами и настройками базы (--create):
  # восстановленная база получает те же права ролей, что исходная. Без сжатия — сжимает и
  # дедуплицирует restic: соседние ночные дампы отличаются немногими кусками
  set +e
  compose exec -T postgres pg_dump -U postgres --format=custom --compress=0 --create "$DB_NAME" |
    restic_ backup --host "$SNAPSHOT_HOST" --tag db --stdin --stdin-filename kchs.dump --json >"$out"
  local codes=("${PIPESTATUS[@]}")
  set -e
  id="$(snapshot_id_of <"$out")"
  rm -f "$out"
  status=0
  [[ "${codes[0]}" == 0 ]] || status=1
  [[ "${codes[1]}" == 0 ]] || status=1
  if [[ "$status" != 0 ]]; then
    # Оборванный дамп не должен остаться снимком: restic не знает, что поток неполный
    [[ -n "$id" ]] && restic_ forget "$id" >/dev/null 2>&1
    failure "копия базы не сделана (pg_dump: ${codes[0]}, restic: ${codes[1]})"
  fi
}

backup_files() {
  docker volume inspect "$MINIO_VOLUME" >/dev/null 2>&1 ||
    failure "нет тома хранилища $MINIO_VOLUME (внешнее S3 копирует его владелец)"
  local paths=() bucket
  for bucket in "${BUCKETS[@]}"; do paths+=("/data/minio/$bucket"); done
  # Файлы как их хранит MinIO (одиночный диск): объект — каталог с xl.meta. Снимок
  # идёт по живому тому: объект записывается целиком и подменяется переименованием.
  # Служебный .minio.sys не копируется — пользователей, политики и правила хранения
  # заводит minio-init из .env при восстановлении
  snapshot -v "$MINIO_VOLUME:/data/minio:ro" backup --tag files "${paths[@]}" ||
    failure "копия файлов не сделана"
}

cmd_run() {
  need_repo
  # Сбой вне известных шагов (Docker не отвечает, нет места) — тоже признак для сторожа
  trap 'printf "%s %s\n" "$(now_iso)" "прогон прерван" >"$BACKUP_DIR/last-failure"' ERR
  local started
  started="$(now_iso)"
  say "── Окружение ──"
  backup_env
  say "── База $DB_NAME ──"
  backup_db
  say "── Файлы: ${BUCKETS[*]} ──"
  backup_files
  say "── Хранение: $KEEP_DAILY дн., $KEEP_WEEKLY нед., $KEEP_MONTHLY мес. ──"
  restic_ forget --host "$SNAPSHOT_HOST" --group-by host,tags --keep-daily "$KEEP_DAILY" \
    --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune --quiet >/dev/null ||
    failure "очистка старых копий не прошла"
  # Ежедневно — структура; по воскресеньям — ещё и пятая часть данных: за месяц
  # перечитывается весь репозиторий
  if [[ "$(date +%u)" == 7 ]]; then
    restic_ check --read-data-subset=20% >/dev/null 2>&1 || failure "проверка репозитория не прошла"
  else
    restic_ check >/dev/null 2>&1 || failure "проверка репозитория не прошла"
  fi
  share_repo
  now_iso >"$BACKUP_DIR/last-success"
  say "Копия готова (начата $started): $REPO"
}

cmd_status() {
  need_repo
  [[ -f "$BACKUP_DIR/last-success" ]] && say "Последняя удачная: $(cat "$BACKUP_DIR/last-success")"
  [[ -f "$BACKUP_DIR/last-failure" ]] && say "Последний сбой:    $(cat "$BACKUP_DIR/last-failure")"
  restic_ snapshots --host "$SNAPSHOT_HOST" --compact
  restic_ stats --mode raw-data 2>/dev/null | sed -n 's/^ *Total Size: */Объём репозитория: /p'
}

cmd_check() {
  need_repo
  if [[ "${1:-}" == --read-data ]]; then
    restic_ check --read-data
  else
    restic_ check
  fi
}

# Компьютер Комитета забирает репозиторий по SSH: отдельный пользователь, только rsync на
# чтение каталога репозитория (rrsync -ro), без оболочки и пересылки портов
cmd_allow_pull() {
  local key="${1:-}" home rrsync
  [[ -f "$key" ]] || die "укажите файл открытого ключа: allow-pull ключ.pub"
  rrsync="$(command -v rrsync || true)"
  [[ -n "$rrsync" ]] || die "нет rrsync (пакет rsync 3.2.4+): apt install rsync"
  # rrsync — сценарий на Python: без python3 сервер отвечал бы обрывом соединения
  if head -1 "$rrsync" | grep -q python && ! command -v python3 >/dev/null 2>&1; then
    die "rrsync требует python3: apt install python3"
  fi
  getent group "$GROUP" >/dev/null 2>&1 || groupadd --system "$GROUP"
  if ! id "$GROUP" >/dev/null 2>&1; then
    useradd --system --gid "$GROUP" --create-home --home-dir "/home/$GROUP" --shell /bin/sh "$GROUP"
  fi
  home="$(getent passwd "$GROUP" | cut -d: -f6)"
  install -d -m 700 -o "$GROUP" -g "$GROUP" "$home/.ssh"
  printf 'command="%s -ro %s",restrict %s\n' "$rrsync" "$REPO" "$(cat "$key")" \
    >>"$home/.ssh/authorized_keys"
  chown "$GROUP:$GROUP" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
  share_repo
  say "Доступ на чтение репозитория выдан ключу $key: пользователь $GROUP, каталог $REPO"
}

cmd_install_timer() {
  local unit=/etc/systemd/system
  cat >"$unit/kchs-backup.service" <<EOF
[Unit]
Description=kchs: резервная копия установки (ADR-0227)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=KCHS_ENV_FILE=$ENV_FILE
Environment=KCHS_BACKUP_DIR=$BACKUP_DIR
Environment=KCHS_BACKUP_PASSWORD_FILE=$PASS_FILE
ExecStart=/usr/bin/env bash $ROOT/infra/scripts/backup.sh run
EOF
  cat >"$unit/kchs-backup.timer" <<'EOF'
[Unit]
Description=kchs: резервная копия каждую ночь

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now kchs-backup.timer
  say "Копия по расписанию: каждую ночь в 03:30 (systemctl list-timers kchs-backup.timer)"
}

# Восстановление на чистую установку: окружение → база → файлы. Тома данных проекта
# стираются, поэтому без --yes команда только объясняет, что сделает
cmd_restore() {
  local snapshot=latest yes=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO="$2"; shift 2 ;;
      --snapshot) snapshot="$2"; shift 2 ;;
      --yes) yes=1; shift ;;
      *) die "restore: неизвестный ключ $1" ;;
    esac
  done
  [[ -f "$PASS_FILE" ]] || die "нет файла пароля $PASS_FILE (KCHS_BACKUP_PASSWORD_FILE)"
  [[ -f "$REPO/config" ]] || die "нет репозитория в $REPO (--repo КАТАЛОГ)"
  if [[ "$yes" != 1 ]]; then
    say "Восстановление в проект compose «${PROJECT}» из ${REPO} (снимки: ${snapshot}):"
    say "  1. .env установки ← копия окружения (прежний сохранится рядом);"
    say "  2. тома ${PROJECT}_pgdata, _miniodata, _meilidata, _redisdata СТИРАЮТСЯ;"
    say "  3. база и файлы ← копия; поиск перестроится из базы."
    say "Запустите с --yes, если это то, что нужно."
    exit 1
  fi
  local filter=(--host "$SNAPSHOT_HOST")
  local env_snap="$snapshot" db_snap="$snapshot" files_snap="$snapshot"

  say "── Окружение ──"
  local restored
  restored="$(mktemp "${TMPDIR:-/tmp}/kchs-env.XXXXXX")"
  restic_ dump "${filter[@]}" --tag env "$env_snap" /kchs.env >"$restored" ||
    die "в репозитории нет копии окружения"
  if [[ -f "$ENV_FILE" ]] && ! cmp -s "$restored" "$ENV_FILE"; then
    cp -p "$ENV_FILE" "$ENV_FILE.before-restore-$(date +%Y%m%d-%H%M%S)"
  fi
  install -m 600 "$restored" "$ENV_FILE"
  rm -f "$restored"
  # Пароли ролей базы и ключи хранилища — из восстановленного окружения
  DB_NAME="$(env_get POSTGRES_DB)"
  DB_NAME="${DB_NAME:-kchs}"

  say "── Чистые тома ──"
  compose --profile app down --remove-orphans >/dev/null 2>&1 || true
  local volume
  for volume in pgdata miniodata meilidata redisdata; do
    docker volume rm -f "${PROJECT}_$volume" >/dev/null 2>&1 || true
  done
  compose up -d --wait postgres minio >/dev/null 2>&1 || die "база и хранилище не поднялись"
  # minio-init — разовый: бакеты, версии, правила хранения, пользователи из .env
  compose run --rm --no-deps minio-init >/dev/null 2>&1 || die "хранилище не настроено (minio-init)"

  say "── База $DB_NAME ──"
  # --create --clean: база пересоздаётся из дампа вместе с её настройками и правами ролей
  restic_ dump "${filter[@]}" --tag db "$db_snap" /kchs.dump |
    compose exec -T postgres pg_restore -U postgres --create --clean --if-exists --exit-on-error -d postgres ||
    die "база не восстановлена"

  say "── Файлы ──"
  compose stop minio >/dev/null 2>&1
  restic_ -v "$MINIO_VOLUME:/restore" restore "${filter[@]}" --tag files "$files_snap:/data/minio" \
    --target /restore --quiet || die "файлы не восстановлены"
  # minio-init ещё раз: файлы уже на месте, а версии и правила — его забота
  compose up -d --wait minio >/dev/null 2>&1 || die "хранилище не поднялось"
  compose run --rm --no-deps minio-init >/dev/null 2>&1 || die "хранилище не настроено (minio-init)"

  say "Готово. Дальше:"
  say "  • поднимите приложение (docker compose --profile app up -d или скрипт установки);"
  say "  • «Администрирование → Резервные копии → Переиндексировать поиск»;"
  say "  • войдите и откройте пару документов и файлов."
}

case "${1:-}" in
  init) cmd_init ;;
  run) cmd_run ;;
  status) cmd_status ;;
  check) shift; cmd_check "$@" ;;
  allow-pull) shift; cmd_allow_pull "$@" ;;
  install-timer) cmd_install_timer ;;
  restore) shift; cmd_restore "$@" ;;
  *) die "команда: init | run | status | check [--read-data] | allow-pull <ключ.pub> | install-timer | restore [--repo КАТАЛОГ] [--snapshot ID] --yes" ;;
esac
