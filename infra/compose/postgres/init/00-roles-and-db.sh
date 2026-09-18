#!/usr/bin/env bash
# Бутстрап кластера kchs: роли БД с минимальными привилегиями, рабочая и
# тестовая базы, расширения в выделенной схеме.
#   05-data-model.md  → «Общие правила», «Роли БД»
#   17-security.md §4 → сырой SQL выполняется ролью kchs_query без доступа к public
set -euo pipefail

DB="${POSTGRES_DB}"
TEST_DB="${POSTGRES_DB}_test"

# ── 1. Роли кластера ─────────────────────────────────────────────────────────
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB" <<-EOSQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_app') THEN
      CREATE ROLE kchs_app LOGIN PASSWORD '${KCHS_APP_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_migrator') THEN
      CREATE ROLE kchs_migrator LOGIN PASSWORD '${KCHS_MIGRATOR_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
      CREATE ROLE kchs_query LOGIN PASSWORD '${KCHS_QUERY_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_readonly') THEN
      CREATE ROLE kchs_readonly LOGIN PASSWORD '${KCHS_READONLY_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_audit') THEN
      CREATE ROLE kchs_audit LOGIN PASSWORD '${KCHS_AUDIT_PASSWORD}';
    END IF;
  END \$\$;

  -- kchs_app понижает себя до kchs_query на время пользовательских запросов
  GRANT kchs_query TO kchs_app;
  GRANT kchs_audit TO kchs_app;

  -- Лимиты роли пользовательских запросов (17-security.md §4)
  ALTER ROLE kchs_query SET statement_timeout = '30s';
  ALTER ROLE kchs_query SET lock_timeout = '3s';
  ALTER ROLE kchs_query SET idle_in_transaction_session_timeout = '60s';
  ALTER ROLE kchs_query SET work_mem = '64MB';
  ALTER ROLE kchs_query SET temp_file_limit = '2GB';
  ALTER ROLE kchs_query SET default_transaction_read_only = on;
  ALTER ROLE kchs_query SET search_path = ds, extensions;

  ALTER ROLE kchs_readonly SET default_transaction_read_only = on;
  ALTER ROLE kchs_readonly SET statement_timeout = '120s';
EOSQL

# ── 2. Тестовая база: интеграционные тесты не трогают рабочие данные ─────────
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  SELECT 'CREATE DATABASE ${TEST_DB} OWNER kchs_app'
   WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}')
  \gexec
EOSQL

# ── 3. Схемы, расширения и привилегии в каждой базе ─────────────────────────
setup_database() {
  local target="$1"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$target" <<-EOSQL
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE SCHEMA IF NOT EXISTS ds  AUTHORIZATION kchs_app;
    CREATE SCHEMA IF NOT EXISTS ops AUTHORIZATION kchs_app;
    CREATE SCHEMA IF NOT EXISTS yjs AUTHORIZATION kchs_app;
    ALTER SCHEMA public OWNER TO kchs_app;

    CREATE EXTENSION IF NOT EXISTS postgis    SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS vector     SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pg_trgm    SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS unaccent   SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pgcrypto   SCHEMA extensions;

    ALTER DATABASE "${target}" SET search_path = public, extensions;

    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON SCHEMA ds, ops, yjs, extensions FROM PUBLIC;
    REVOKE ALL ON DATABASE "${target}" FROM PUBLIC;

    GRANT CONNECT ON DATABASE "${target}"
      TO kchs_app, kchs_migrator, kchs_query, kchs_readonly, kchs_audit;
    GRANT CREATE ON DATABASE "${target}" TO kchs_migrator;

    GRANT USAGE ON SCHEMA extensions
      TO kchs_app, kchs_migrator, kchs_query, kchs_readonly, kchs_audit;
    GRANT SELECT ON TABLE extensions.spatial_ref_sys
      TO kchs_app, kchs_migrator, kchs_query, kchs_readonly;

    GRANT ALL ON SCHEMA public, ds, ops, yjs TO kchs_app, kchs_migrator;

    -- kchs_query: только схема ds, ничего в public (критерий приёмки P0-E02)
    GRANT USAGE ON SCHEMA ds TO kchs_query;
    ALTER DEFAULT PRIVILEGES FOR ROLE kchs_app      IN SCHEMA ds GRANT SELECT ON TABLES TO kchs_query;
    ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA ds GRANT SELECT ON TABLES TO kchs_query;

    GRANT USAGE ON SCHEMA public, ds, ops TO kchs_readonly;
    ALTER DEFAULT PRIVILEGES FOR ROLE kchs_app      IN SCHEMA public, ds, ops GRANT SELECT ON TABLES TO kchs_readonly;
    ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA public, ds, ops GRANT SELECT ON TABLES TO kchs_readonly;

    GRANT USAGE ON SCHEMA public TO kchs_audit;
EOSQL
}

setup_database "$DB"
setup_database "$TEST_DB"

echo "kchs: схемы, расширения и роли БД готовы ($DB, $TEST_DB)"
