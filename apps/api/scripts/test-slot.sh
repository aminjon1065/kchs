#!/usr/bin/env bash
# Отдельная тестовая база для параллельного прогона интеграционных тестов:
#   bash apps/api/scripts/test-slot.sh 2   → база kchs_test_2
#   KCHS_TEST_SLOT=2 pnpm --filter @kchs/api test:integration
# Redis (база 1+N) и префикс индекса Meilisearch выбирает test/helpers.ts.
set -euo pipefail
slot="${1:?укажите номер слота 1…14}"
[[ "$slot" =~ ^([1-9]|1[0-4])$ ]] || { echo "слот — число 1…14" >&2; exit 1; }
root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker compose --env-file "$root/.env" -f "$root/infra/compose/docker-compose.yml" exec -T \
  -e KCHS_TEST_DB="kchs_test_${slot}" postgres \
  bash /docker-entrypoint-initdb.d/00-roles-and-db.sh
