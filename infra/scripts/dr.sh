#!/usr/bin/env bash
# Резервный узел S1 (ADR-0199): горячий standby Postgres, архив WAL и зеркало
# хранилища на удалённой площадке; переключение по runbook.
#
#   На основном сервере:
#     dr.sh primary-setup            роль репликации, слоты, строка pg_hba, пользователь зеркала
#     dr.sh status                   кто подключён, сколько WAL держится для узла
#     dr.sh stop-app                 плановое переключение: остановить приложение, дождаться узла
#   На резервном узле:
#     dr.sh init-standby [--yes]     засеять базу копией основного и запустить узел
#     dr.sh status                   отставание, архив WAL, базовые копии, зеркало
#     dr.sh basebackup               базовая копия для восстановления на момент (раз в неделю)
#     dr.sh restore-check [--smoke]  проверка восстановления во временном проекте (раз в месяц)
#     dr.sh pitr 'ГГГГ-ММ-ДД ЧЧ:ММ:СС+05'  отдельная база на момент времени (логическая ошибка)
#     dr.sh pitr-down                убрать базу pitr
#     dr.sh promote [--yes]          сделать узел основным и запустить на нём приложение
#
# Окружение — .env установки (KCHS_ENV_FILE), на узле — копия .env основного с
# разделом «Резервный узел» (.env.example). Проект compose — KCHS_PROJECT (kchs).
# Порядок действий, проверки и возврат — infra/runbooks/failover.md и failback.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KCHS_ENV_FILE:-$ROOT/.env}"
PROJECT="${KCHS_PROJECT:-kchs}"
MAIN="$ROOT/infra/compose/docker-compose.yml"
DR="$ROOT/infra/compose/dr.yml"

die() { echo "dr.sh: $*" >&2; exit 1; }
say() { echo "── $* ──"; }

[[ -f "$ENV_FILE" ]] || die "нет файла окружения $ENV_FILE (KCHS_ENV_FILE)"

# Значение из окружения процесса, иначе из .env установки
env_get() {
  local key="$1" fallback="${2:-}" value
  value="$(printenv "$key" || true)"
  if [[ -z "$value" ]]; then
    value="$(sed -n "s/^$key=//p" "$ENV_FILE" | tail -1)"
  fi
  printf '%s' "${value:-$fallback}"
}
need() {
  local value
  value="$(env_get "$1")"
  [[ -n "$value" ]] || die "$1 не задан (.env, раздел «Резервный узел»)"
  printf '%s' "$value"
}

DB="$(env_get POSTGRES_DB kchs)"

# Основной сервер — обычный compose установки; узел — с надстройкой dr.yml
pcompose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$MAIN" "$@"; }
dcompose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$MAIN" -f "$DR" "$@"; }

# psql суперпользователя внутри контейнера postgres (сокет, без пароля)
psql_in() { "$1" exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -X -q -t -A "${@:2}"; }

in_recovery() { psql_in "$1" -c "select pg_is_in_recovery()" 2>/dev/null | tr -d '[:space:]'; }

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ── Основной сервер ───────────────────────────────────────────────────────────

primary_setup() {
  local cidr password monitor
  cidr="$(need KCHS_DR_CIDR)"
  password="$(need POSTGRES_REPLICATION_PASSWORD)"
  monitor="$(env_get KCHS_MONITOR_PASSWORD)"
  [[ "$(in_recovery pcompose)" == f ]] || die "postgres не запущен или это standby — команда для основного сервера"

  say "Роль репликации и слоты"
  # Два слота: kchs_dr — для standby, kchs_dr_wal — для архива WAL. Слот держит WAL,
  # пока узел его не забрал; предел — max_slot_wal_keep_size (POSTGRES_MAX_SLOT_WAL_KEEP_SIZE)
  pcompose exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -X -q \
    -v pw="$password" >/dev/null <<'SQL'
SELECT 'CREATE ROLE kchs_replicator WITH REPLICATION LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_replicator')
\gexec
ALTER ROLE kchs_replicator WITH REPLICATION LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  CONNECTION LIMIT 5 PASSWORD :'pw';
SELECT pg_create_physical_replication_slot(name, true)
  FROM (VALUES ('kchs_dr'), ('kchs_dr_wal')) AS s(name)
 WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = s.name);
SQL
  # Экспортёр метрик на узле ходит ролью kchs_monitor (ADR-0147): standby её не
  # изменит, поэтому она заводится здесь и приходит на узел репликацией
  if [[ -n "$monitor" ]]; then
    pcompose exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -X -q \
      -v mon="$monitor" -v db="$DB" >/dev/null <<'SQL'
SET client_min_messages = warning;
SELECT 'CREATE ROLE kchs_monitor LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_monitor')
\gexec
ALTER ROLE kchs_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5 PASSWORD :'mon';
GRANT pg_monitor TO kchs_monitor;
GRANT CONNECT ON DATABASE :"db" TO kchs_monitor;
ALTER ROLE kchs_monitor SET statement_timeout = '15s';
ALTER ROLE kchs_monitor SET default_transaction_read_only = on;
SQL
  fi

  say "Доступ узла в pg_hba.conf ($cidr)"
  # Репликационное подключение строка `host all all …` не покрывает: нужна своя
  pcompose exec -T -e LINE="host replication kchs_replicator $cidr scram-sha-256" postgres \
    bash -c 'f="$PGDATA/pg_hba.conf"; grep -qxF "$LINE" "$f" || { echo "$LINE" >> "$f"; echo "  добавлено: $LINE"; }'
  psql_in pcompose -c "select pg_reload_conf()" >/dev/null

  say "Пользователь зеркала хранилища"
  if [[ -n "$(env_get S3_DR_SECRET_KEY)" ]]; then
    pcompose run --rm --no-deps minio-init 2>&1 | grep -E 'зеркала|бакеты' | sed 's/^/  /' || true
  else
    echo "  S3_DR_SECRET_KEY не задан — generate-secrets.sh --add-missing и повторить"
  fi

  echo
  echo "Основной сервер готов принять резервный узел. Postgres должен слушать адрес VPN:"
  echo "POSTGRES_BIND в .env и docker compose up -d postgres. Дальше на узле — dr.sh init-standby."
}

stop_app() {
  [[ "$(in_recovery pcompose)" == f ]] || die "это не основной сервер"
  say "Остановка приложения (плановое переключение)"
  pcompose --profile app stop web api worker engine
  psql_in pcompose -c "checkpoint" >/dev/null
  echo "Последняя позиция WAL основного: $(psql_in pcompose -c 'select pg_current_wal_lsn()')"
  echo "На узле dr.sh status: когда «принято» и «применено» сравняются с ней — dr.sh promote."
}

# ── Резервный узел ────────────────────────────────────────────────────────────

init_standby() {
  local yes="$1" host port password volume
  host="$(need KCHS_DR_PRIMARY_HOST)"
  port="$(env_get KCHS_DR_PRIMARY_PG_PORT 5432)"
  password="$(need POSTGRES_REPLICATION_PASSWORD)"
  need KCHS_DR_PRIMARY_S3 >/dev/null
  volume="${PROJECT}_pgdata"

  if docker volume inspect "$volume" >/dev/null 2>&1 && [[ "$yes" != 1 ]]; then
    die "том $volume уже есть: база узла будет заменена копией основного. Повторите с --yes"
  fi

  say "Копия базы основного ($host:$port)"
  dcompose --profile dr stop wal-receiver >/dev/null 2>&1 || true
  dcompose stop postgres >/dev/null 2>&1 || true
  # Скрипт идёт в контейнер через stdin: значения — переменными окружения, а не в тексте
  if ! dcompose run --rm --no-deps -T --entrypoint bash \
    -e PRIMARY_HOST="$host" -e PRIMARY_PORT="$port" -e PGPASSWORD="$password" \
    postgres -s <<'SCRIPT'
set -euo pipefail
D=/var/lib/postgresql/data
# Сначала — что основной готов (доступ, роль, слот): прежняя копия стирается только потом
slot="$(psql "host=$PRIMARY_HOST port=$PRIMARY_PORT user=kchs_replicator replication=true" \
  -X -t -A -c "READ_REPLICATION_SLOT kchs_dr" 2>&1)" || {
  echo "основной недоступен ролью kchs_replicator: $slot" >&2
  exit 1
}
case "$slot" in
  physical*) ;;
  *) echo "на основном нет слота kchs_dr — сначала dr.sh primary-setup на основном" >&2; exit 1 ;;
esac
find "$D" -mindepth 1 -delete
chown postgres:postgres "$D"
chmod 700 "$D"
gosu postgres pg_basebackup --pgdata="$D" --host="$PRIMARY_HOST" --port="$PRIMARY_PORT" \
  --username=kchs_replicator --no-password --wal-method=stream --slot=kchs_dr \
  --checkpoint=fast --progress
# Standby сам подключается к основному: VPN открыт в эту сторону
cat >> "$D/postgresql.auto.conf" <<EOF
primary_conninfo = 'host=$PRIMARY_HOST port=$PRIMARY_PORT user=kchs_replicator password=$PGPASSWORD application_name=kchs_dr'
primary_slot_name = 'kchs_dr'
hot_standby_feedback = on
EOF
touch "$D/standby.signal"
chown postgres:postgres "$D/postgresql.auto.conf" "$D/standby.signal"
SCRIPT
  then
    # Прежняя копия цела (основной не готов) — узел возвращается как был. Пустой том
    # не запускается: образ Postgres завёл бы в нём новую пустую базу
    if dcompose run --rm --no-deps -T --entrypoint test postgres -f "/var/lib/postgresql/data/PG_VERSION"; then
      dcompose up -d postgres >/dev/null 2>&1 || true
      die "засев не выполнен — прежняя база узла запущена снова"
    fi
    die "засев не выполнен, база узла пуста — устраните причину и повторите init-standby"
  fi

  set_aside_history

  say "Запуск узла"
  dcompose up -d --wait postgres
  dcompose up -d --wait minio
  # minio-init (бакеты, пользователи) — зависимость зеркала: compose дождётся его сам
  dcompose --profile dr up -d wal-receiver s3-mirror
  [[ "$(in_recovery dcompose)" == t ]] || die "postgres узла запустился не как standby"
  status_standby
}

# Архив WAL и базовые копии прежней истории (до переключения или прошлого засева) к
# новой копии не подходят: pg_receivewal продолжил бы с их позиции. Они не стираются,
# а уходят в previous-<время> — их видно, удалить можно руками
set_aside_history() {
  local stamp volume
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  for volume in "${PROJECT}_drwal" "${PROJECT}_drbase"; do
    docker volume inspect "$volume" >/dev/null 2>&1 || continue
    docker run --rm -v "$volume:/v" -e STAMP="$stamp" -e VOLUME="$volume" kchs/postgres:17-3.5 bash -c '
      shopt -s nullglob dotglob
      items=()
      for item in /v/*; do [[ "$(basename "$item")" == previous-* ]] || items+=("$item"); done
      [[ ${#items[@]} -gt 0 ]] || exit 0
      mkdir -p "/v/previous-$STAMP"
      mv "${items[@]}" "/v/previous-$STAMP/"
      echo "  прежняя история отложена: $VOLUME/previous-$STAMP (${#items[@]})"'
  done
}

status_standby() {
  say "Репликация"
  psql_in dcompose -F ' | ' <<'SQL'
SELECT 'принято: ' || coalesce(pg_last_wal_receive_lsn()::text, '—')
    || '; применено: ' || coalesce(pg_last_wal_replay_lsn()::text, '—')
    || '; последняя транзакция: ' || coalesce(pg_last_xact_replay_timestamp()::text, '—')
    || '; отставание: ' || CASE
         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN '0 (всё применено)'
         ELSE coalesce(round(extract(epoch FROM now() - pg_last_xact_replay_timestamp()))::text || ' с', '—')
       END;
SELECT 'поток с основного: ' || coalesce((SELECT status || ', ' || sender_host || ':' || sender_port
                                            FROM pg_stat_wal_receiver), 'нет');
SQL
  say "Архив WAL"
  dcompose --profile dr exec -T wal-receiver bash -c \
    'n=$(ls /wal | grep -c "^[0-9A-F]\{24\}" || true); last=$(ls /wal | grep "^[0-9A-F]\{24\}" | sort | tail -1); echo "  сегментов: $n, последний: ${last:-—}, объём: $(du -sh /wal | cut -f1)"' \
    2>/dev/null || echo "  wal-receiver не запущен"
  say "Базовые копии"
  dcompose exec -T postgres bash -c 'ls -1 /basebackups 2>/dev/null | grep -E "^[0-9]{8}T[0-9]{6}Z$" | sed "s/^/  /"; true'
  say "Зеркало хранилища"
  dcompose --profile dr ps --format '  {{.Service}}: {{.Status}}' s3-mirror wal-receiver 2>/dev/null || true
}

status_primary() {
  say "Узлы, подключённые к основному"
  psql_in pcompose -F ' | ' <<'SQL'
SELECT '  ' || application_name || ' ' || coalesce(client_addr::text, 'локально') || ': ' || state
    || ', не записано на узле ' || coalesce(pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn)), '—')
  FROM pg_stat_replication;
SELECT '  слот ' || slot_name || ': ' || CASE WHEN active THEN 'забирает' ELSE 'НЕ ПОДКЛЮЧЁН' END
    || ', держит WAL ' || pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
    || ', состояние ' || coalesce(wal_status, '—')
  FROM pg_replication_slots WHERE slot_name LIKE 'kchs_dr%';
SQL
}

status() {
  # Узел узнаётся по адресу основного в .env; основной — по его отсутствию
  local compose=pcompose
  [[ -n "$(env_get KCHS_DR_PRIMARY_HOST)" ]] && compose=dcompose
  case "$(in_recovery "$compose")" in
    t) status_standby ;;
    f) status_primary ;;
    *) die "postgres проекта $PROJECT не отвечает" ;;
  esac
}

# Имя сегмента WAL по LSN начала копии: сегменты 16 МБ (размер по умолчанию)
wal_segment() {
  local timeline="$1" lsn="$2" hi lo
  hi="${lsn%%/*}"
  lo="${lsn##*/}"
  printf '%08X%08X%08X' "$timeline" "$((16#$hi))" "$(((16#$lo) >> 24))"
}

basebackup() {
  local keep stamp backups oldest manifest timeline lsn segment
  keep="$(env_get KCHS_DR_BASEBACKUP_KEEP 4)"
  [[ "$(in_recovery dcompose)" == t ]] || die "базовая копия снимается со standby резервного узла"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  say "Базовая копия $stamp"
  dcompose exec -T -u root postgres chown postgres:postgres /basebackups
  # С самого standby: основной не нагружается, а WAL копии приходит потоком
  dcompose exec -T -u postgres postgres pg_basebackup --pgdata="/basebackups/$stamp" \
    --format=tar --gzip --wal-method=stream --checkpoint=fast --no-password

  say "Хранение: последние $keep"
  backups="$(dcompose exec -T postgres bash -c 'ls -1 /basebackups | grep -E "^[0-9]{8}T[0-9]{6}Z$" | sort')"
  local count
  count="$(printf '%s\n' "$backups" | grep -c . || true)"
  if (( count > keep )); then
    printf '%s\n' "$backups" | head -n "$((count - keep))" | while read -r old; do
      [[ -n "$old" ]] || continue
      dcompose exec -T -u postgres postgres rm -rf "/basebackups/$old"
      echo "  удалена $old"
    done
  fi
  # Архив WAL старше самой старой оставшейся копии больше не нужен
  oldest="$(printf '%s\n' "$backups" | tail -n "$keep" | head -1)"
  manifest="$(dcompose exec -T postgres cat "/basebackups/$oldest/backup_manifest")"
  timeline="$(printf '%s' "$manifest" | sed -n 's/.*"Timeline": *\([0-9]*\).*/\1/p' | head -1)"
  lsn="$(printf '%s' "$manifest" | sed -n 's/.*"Start-LSN": *"\([0-9A-F]*\/[0-9A-F]*\)".*/\1/p' | head -1)"
  if [[ -n "$timeline" && -n "$lsn" ]]; then
    segment="$(wal_segment "$timeline" "$lsn")"
    dcompose --profile dr exec -T -u postgres wal-receiver pg_archivecleanup /wal "$segment"
    echo "  архив WAL — с сегмента $segment (копия $oldest)"
  fi
}

# ── Восстановление из базовой копии и архива WAL ──────────────────────────────

# Временный проект восстановления: свои порты на 127.0.0.1 и свой том; рабочий
# узел не трогается. Копия рабочей базы никуда не пишет наружу: ни бота, ни почты,
# ни медиасервера, ни прокси
restore_project() {
  local name="$1" base="$2"
  RP_PROJECT="${PROJECT}-$name"
  RP_VOLUME="${PROJECT}-$name-pgdata"
  RP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/kchs-$name.XXXXXX")"
  export POSTGRES_BIND=127.0.0.1 KCHS_BIND=127.0.0.1
  export POSTGRES_PORT="$((base + 432))" REDIS_PORT="$((base + 379))" MEILI_PORT="$((base + 700))"
  export S3_PORT="$((base + 900))" S3_CONSOLE_PORT="$((base + 901))" API_PORT="$((base + 300))"
  export ENGINE_PORT="$((base + 800))" WEB_PORT="$((base + 80))" WEB_HTTPS_PORT="$((base + 443))"
  export MAILPIT_SMTP_PORT="$((base + 25))" MAILPIT_UI_PORT="$((base + 825))"
  export TELEGRAM_BOT_TOKEN='' TELEGRAM_POLLING=false SMTP_URL_INTERNAL=smtp://127.0.0.1:9
  export LIVEKIT_API_KEY='' LIVEKIT_API_SECRET='' HTTP_PROXY='' HTTPS_PROXY=''
  # База копии — свой том; архив WAL узла — только на чтение
  cat >"$RP_WORK/restore.yml" <<YAML
services:
  postgres:
    volumes: !override
      - restorepg:/var/lib/postgresql/data
      - drwal:/wal:ro
volumes:
  restorepg:
    external: true
    name: $RP_VOLUME
  drwal:
    external: true
    name: ${PROJECT}_drwal
YAML
}

rcompose() {
  docker compose -p "$RP_PROJECT" --env-file "$ENV_FILE" -f "$MAIN" -f "$RP_WORK/restore.yml" "$@"
}

restore_down() {
  rcompose --profile app down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "$RP_VOLUME" >/dev/null 2>&1 || true
}

# Базовая копия: последняя или последняя до момента (ГГГГММДДTЧЧММССZ по UTC)
base_backup_before() {
  local before="${1:-99999999T999999Z}"
  docker run --rm -v "${PROJECT}_drbase:/basebackups:ro" -e BEFORE="$before" kchs/postgres:17-3.5 \
    bash -c 'ls -1 /basebackups | grep -E "^[0-9]{8}T[0-9]{6}Z$" | sort | awk -v b="$BEFORE" "\$0 < b" | tail -1'
}

# Том копии: базовая копия, затем архив WAL узла — до конца или до момента TARGET.
# Копия не подключается к основному и после восстановления уходит на свою линию
# времени. Последний сегмент pg_receivewal пишет с суффиксом .partial
restore_volume() {
  local backup="$1" target="${2:-}"
  docker volume create "$RP_VOLUME" >/dev/null
  docker run --rm -i -v "${PROJECT}_drbase:/basebackups:ro" -v "$RP_VOLUME:/data" \
    -e BACKUP="$backup" -e TARGET="$target" kchs/postgres:17-3.5 bash -s <<'SCRIPT'
set -euo pipefail
tar -xzf "/basebackups/$BACKUP/base.tar.gz" -C /data
mkdir -p /data/pg_wal
tar -xzf "/basebackups/$BACKUP/pg_wal.tar.gz" -C /data/pg_wal
rm -f /data/standby.signal /data/postmaster.pid
cat >> /data/postgresql.auto.conf <<'EOF'
primary_conninfo = ''
primary_slot_name = ''
restore_command = 'test -f /wal/%f && cp /wal/%f %p || { test -f /wal/%f.partial && cp /wal/%f.partial %p; }'
recovery_target_timeline = 'latest'
recovery_target_action = 'promote'
EOF
if [[ -n "$TARGET" ]]; then
  echo "recovery_target_time = '$TARGET'" >> /data/postgresql.auto.conf
fi
touch /data/recovery.signal
chown -R postgres:postgres /data
chmod 700 /data
SCRIPT
}

# Дождаться конца восстановления (копия повышается сама); пусто — успех, иначе причина
wait_recovered() {
  local limit waited=0
  limit="$(env_get KCHS_DR_CHECK_TIMEOUT 1800)"
  rcompose up -d --wait postgres >/dev/null
  until [[ "$(in_recovery rcompose)" == f ]]; do
    sleep 5
    waited=$((waited + 5))
    if ((waited >= limit)); then
      echo "восстановление не завершилось за ${limit} с: $(rcompose logs --tail=5 --no-log-prefix postgres 2>&1 | tr '\n' ' ' | cut -c1-600)"
      return 0
    fi
  done
}

# Время последней записи аудита — по UTC в ISO 8601: по нему видно, до какого
# момента дошли данные копии
LAST_AUDIT="select coalesce(to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') from public.audit_log"

restore_check() {
  local smoke="$1"
  local started finished latest rpo standby_max restored_max migrations users objects lag failure
  local ok=true details="" host
  host="$(env_get KCHS_DR_NAME "$(hostname -s 2>/dev/null || hostname)")"
  rpo="$(env_get KCHS_DR_RPO_SECONDS 3600)"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  latest="$(base_backup_before)"
  [[ -n "$latest" ]] || die "базовых копий нет — сначала dr.sh basebackup"

  restore_project drcheck "${KCHS_DR_CHECK_PORT_BASE:-46000}"
  restore_down
  trap 'restore_down; rm -rf "$RP_WORK"' EXIT

  say "Восстановление копии $latest и архива WAL во временном проекте $RP_PROJECT"
  restore_volume "$latest"
  failure="$(wait_recovered)"
  if [[ -n "$failure" ]]; then
    ok=false
    details="$failure"
  fi

  if [[ "$ok" == true ]]; then
    migrations="$(psql_in rcompose -c 'select count(*) from public.__migrations')"
    users="$(psql_in rcompose -c 'select count(*) from public.users')"
    objects="$(psql_in rcompose -c 'select count(*) from public.objects')"
    restored_max="$(psql_in rcompose -c "$LAST_AUDIT")"
    standby_max="$(psql_in dcompose -c "$LAST_AUDIT" 2>/dev/null || true)"
    details="копия $latest; миграций $migrations, пользователей $users, объектов $objects"
    if [[ -z "$restored_max" || "$users" == 0 || "$migrations" == 0 ]]; then
      ok=false
      details="$details; восстановленная база пуста"
    elif [[ -n "$standby_max" ]]; then
      # Насколько данные копии старше данных узла — фактическая потеря при
      # восстановлении из архива (RPO)
      lag="$(psql_in rcompose -c "select greatest(0, round(extract(epoch from '$standby_max'::timestamptz - '$restored_max'::timestamptz)))::int")"
      details="$details; данные копии отстают от узла на $lag с (допустимо $rpo)"
      ((lag <= rpo)) || ok=false
    fi
    echo "  $details"
  fi

  if [[ "$ok" == true ]]; then
    say "Приложение на восстановленной копии"
    if rcompose --profile app up -d --wait --wait-timeout 300 \
      redis redis-cache minio minio-init meilisearch api >/dev/null 2>&1 &&
      curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null; then
      details="$details; api запустился, миграции согласованы"
    else
      ok=false
      details="$details; api не запустился: $(rcompose logs --tail=5 --no-log-prefix api 2>&1 | tr '\n' ' ' | cut -c1-400)"
    fi
  fi

  # Дымовой прогон — на стенде с демо-данными (учётки user0NN): KCHS_DR_SMOKE_*
  if [[ "$ok" == true && "$smoke" == 1 ]]; then
    say "Дымовой прогон API"
    # Без worker: он разослал бы события копии наружу (вебхуки, ленты, правила)
    if KCHS_SMOKE_BASE="http://127.0.0.1:$API_PORT/api/v1" KCHS_SMOKE_SKIP_SEARCH=1 \
      KCHS_SMOKE_ADMIN_PASSWORD="$(need KCHS_DR_SMOKE_ADMIN_PASSWORD)" \
      KCHS_SMOKE_USER_PASSWORD="$(env_get KCHS_DR_SMOKE_USER_PASSWORD 'Kchs!Work-2026-3v')" \
      bash "$ROOT/infra/scripts/smoke-api.sh" >"$RP_WORK/smoke.log" 2>&1; then
      details="$details; дымовой прогон: проверок $(grep -c '✓' "$RP_WORK/smoke.log")"
    else
      ok=false
      details="$details; дымовой прогон: $(grep '✗' "$RP_WORK/smoke.log" | head -3 | tr '\n' ' ')"
    fi
    tail -3 "$RP_WORK/smoke.log"
  fi

  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report "$ok" "$started" "$finished" "${restored_max:-}" "$host" "$details"
  if [[ "$ok" == true ]]; then
    echo "Проверка восстановления пройдена: $details"
  else
    echo "Проверка восстановления НЕ пройдена: $details" >&2
    return 1
  fi
}

# Восстановление на момент времени — для разбора логической ошибки (удалили, и это
# уже повторил standby): отдельная база на 127.0.0.1, из которой забирают нужное.
# Рабочие узлы не трогаются; убрать — dr.sh pitr-down
pitr() {
  local target="$1" stamp backup failure
  [[ -n "$target" ]] || die "укажите момент: dr.sh pitr '2026-10-12 08:00:00+05'"
  stamp="$(TARGET="$target" python3 -c '
import os
from datetime import datetime, timezone
value = datetime.fromisoformat(os.environ["TARGET"].strip())
if value.tzinfo is None:
    raise SystemExit("укажите часовой пояс: 2026-10-12 08:00:00+05")
print(value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))')" || die "момент не разобран: $target"
  backup="$(base_backup_before "$stamp")"
  [[ -n "$backup" ]] || die "нет базовой копии раньше $target — архив не дотягивается до этого момента"

  restore_project pitr "${KCHS_DR_PITR_PORT_BASE:-47000}"
  restore_down
  trap 'rm -rf "$RP_WORK"' EXIT
  say "Восстановление копии $backup до $target в проекте $RP_PROJECT"
  restore_volume "$backup" "$target"
  failure="$(wait_recovered)"
  [[ -z "$failure" ]] || die "$failure"
  echo "  данные копии — по $(psql_in rcompose -c "$LAST_AUDIT") (последняя запись аудита)"
  echo
  echo "База на момент $target: 127.0.0.1:$POSTGRES_PORT, роли и пароли — как в .env."
  echo "Нужное забирают выгрузкой, например:"
  echo "  docker compose -p $RP_PROJECT exec -T postgres pg_dump -U postgres -d $DB -t <таблица> > lost.sql"
  echo "Убрать: KCHS_PROJECT=$PROJECT dr.sh pitr-down"
}

pitr_down() {
  restore_project pitr "${KCHS_DR_PITR_PORT_BASE:-47000}"
  trap 'rm -rf "$RP_WORK"' EXIT
  restore_down
  echo "Проект $RP_PROJECT и его том удалены"
}

# Итог — платформе, токеном служебной записи «Резервный узел» (область write:backups)
report() {
  local ok="$1" started="$2" finished="$3" recovered="$4" host="$5" details="$6" url token body
  url="$(env_get KCHS_DR_REPORT_URL)"
  token="$(env_get KCHS_DR_REPORT_TOKEN)"
  if [[ -z "$url" || -z "$token" ]]; then
    echo "  KCHS_DR_REPORT_URL или KCHS_DR_REPORT_TOKEN не заданы — итог платформе не отправлен"
    return 0
  fi
  body="$(OK="$ok" STARTED="$started" FINISHED="$finished" RECOVERED="$recovered" HOST_NAME="$host" \
    DETAILS="$details" python3 -c '
import json, os
recovered = os.environ["RECOVERED"].strip()
print(json.dumps({
    "kind": "pitr",
    "ok": os.environ["OK"] == "true",
    "startedAt": os.environ["STARTED"],
    "finishedAt": os.environ["FINISHED"],
    "recoveredTo": recovered or None,
    "host": os.environ["HOST_NAME"][:200],
    "details": os.environ["DETAILS"][:4000],
}))')"
  if curl -fsS -o /dev/null -X POST "$url/backups/restore-checks" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body"; then
    echo "  итог отправлен платформе"
  else
    echo "  итог платформе не отправлен (адрес или токен) — проверка записана только здесь" >&2
  fi
}

promote() {
  local yes="$1" waited=0
  [[ "$yes" == 1 ]] || die "узел станет основным, а основной — бывшим. Повторите с --yes (runbook failover.md)"
  case "$(in_recovery dcompose)" in
    t) ;;
    f) echo "postgres узла уже основной" ;;
    *) die "postgres узла не отвечает" ;;
  esac
  say "Остановка архива и зеркала"
  dcompose --profile dr stop wal-receiver s3-mirror >/dev/null 2>&1 || true
  if [[ "$(in_recovery dcompose)" == t ]]; then
    say "Повышение standby"
    psql_in dcompose -c "select pg_promote(true, 120)" >/dev/null
    until [[ "$(in_recovery dcompose)" == f ]]; do
      sleep 2
      waited=$((waited + 2))
      (( waited < 120 )) || die "standby не стал основным за 120 с"
    done
  fi
  say "Запуск приложения на узле"
  dcompose --profile app up -d --wait --wait-timeout 600
  echo
  echo "Узел работает основным. Дальше по runbook failover.md: адрес (DNS) — на узел,"
  echo "«Переиндексировать поиск» в консоли, проверка входа и «Здоровья системы»."
}

command="${1:-help}"
shift || true
yes=0
smoke=0
target=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --smoke) smoke=1 ;;
    -*) die "неизвестный параметр: $arg" ;;
    *) [[ "$command" == pitr && -z "$target" ]] || die "лишний параметр: $arg"; target="$arg" ;;
  esac
done

case "$command" in
  primary-setup) primary_setup ;;
  stop-app) stop_app ;;
  init-standby) init_standby "$yes" ;;
  status) status ;;
  basebackup) basebackup ;;
  restore-check) restore_check "$smoke" ;;
  pitr) pitr "$target" ;;
  pitr-down) pitr_down ;;
  promote) promote "$yes" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
