# PostgreSQL 17 + PostGIS 3.5 + pgvector + pg_trgm/btree_gist/unaccent.
#
# Собственный образ вместо postgis/postgis: нам нужно разместить расширения
# в выделенной схеме `extensions`, чтобы роль kchs_query могла пользоваться
# ST_*/vector, не получая никаких прав на схему `public`
# (05-data-model.md → «Роли БД», 17-security.md §4).
FROM postgres:17-bookworm

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-17-postgis-3 \
        postgresql-17-postgis-3-scripts \
        postgresql-17-pgvector; \
    rm -rf /var/lib/apt/lists/*
