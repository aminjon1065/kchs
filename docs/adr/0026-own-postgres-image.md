# 0026. Собственный образ PostgreSQL вместо `postgis/postgis`

Статус: Принято

Контекст: нужен PostgreSQL 17 с PostGIS 3.5 и pgvector одновременно. Образ
`postgis/postgis:17-3.5` не содержит pgvector и выполняет собственный
init-скрипт, который создаёт PostGIS в схеме `public` целевой базы — это
конфликтует с ADR-0025.

Решение: `infra/compose/postgres/Dockerfile` на базе официального
`postgres:17-bookworm` с установкой `postgresql-17-postgis-3`,
`postgresql-17-postgis-3-scripts` и `postgresql-17-pgvector` из репозитория PGDG.
Расширения создаёт наш init-скрипт в схеме `extensions`.

Альтернативы: `postgis/postgis` + отдельная сборка pgvector (два источника
правды); `imresamu/postgis` (неофициальный образ).

Последствия: первая сборка образа занимает ~1–2 минуты; версии PostGIS и
pgvector обновляются вместе с базовым образом PGDG. В CI образ кэшируется.
