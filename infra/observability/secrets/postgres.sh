#!/usr/bin/env bash
# Роль kchs_monitor для экспортёра Postgres (ADR-0147): только pg_monitor и CONNECT,
# без доступа к данным. Пароль — KCHS_MONITOR_PASSWORD из .env; если его нет (.env
# старше этой версии), пароль придумывается один раз и хранится в томе секретов.
# Экспортёр читает его из файла, поэтому смена пароля в .env пересоздаёт этот
# контейнер, а за ним перезапускается и экспортёр (depends_on.restart).
set -euo pipefail

file=/secrets/postgres-password
password="${KCHS_MONITOR_PASSWORD:-}"
if [[ -z "$password" ]]; then
  if [[ -s "$file" ]]; then
    password="$(<"$file")"
  else
    password="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
    echo "kchs: KCHS_MONITOR_PASSWORD не задан — пароль роли kchs_monitor создан в томе секретов"
  fi
fi

psql -v ON_ERROR_STOP=1 -v pw="$password" -v db="$PGDATABASE" --quiet <<'SQL'
SELECT 'CREATE ROLE kchs_monitor LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_monitor')
\gexec
ALTER ROLE kchs_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5 PASSWORD :'pw';
GRANT pg_monitor TO kchs_monitor;
GRANT CONNECT ON DATABASE :"db" TO kchs_monitor;
ALTER ROLE kchs_monitor SET statement_timeout = '15s';
ALTER ROLE kchs_monitor SET default_transaction_read_only = on;
SQL

umask 077
printf '%s' "$password" > "$file.tmp"
chown 65534:65534 "$file.tmp"
mv "$file.tmp" "$file"
echo "kchs: роль kchs_monitor готова"
