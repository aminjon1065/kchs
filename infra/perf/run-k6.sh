#!/usr/bin/env bash
# Замер бюджетов производительности API (04-verification.md §4) профилем k6
# (infra/perf/k6/<профиль>.js). k6 запускается в Docker — ставить его не нужно.
#
#   bash infra/perf/run-k6.sh                  # стенд разработки: api :3000 с демо-данными
#   KCHS_PERF_PROFILE=data-queries bash infra/perf/run-k6.sh  # запросы к датасету 5 млн строк
#   KCHS_PERF_PROFILE=gis-tiles bash infra/perf/run-k6.sh     # векторные тайлы слоя (ADR-0064)
#   KCHS_PERF_API=http://host.docker.internal:8080/api/v1 bash infra/perf/run-k6.sh  # через web
#   KCHS_PERF_RATE=2 KCHS_PERF_DURATION=30s bash infra/perf/run-k6.sh               # мягче и короче
#
# Остальные параметры — KCHS_PERF_* в начале профиля (логины и пароли демо-данных,
# число сотрудников, порог входа). Профиль создаёт своё пространство «Нагрузочный
# профиль» с папками и сообщениями — на общем стенде это видно участникам.
# Итог — таблица p95 по операциям (и в сводке GitHub Actions); полный отчёт k6
# в JSON — в KCHS_PERF_OUT_DIR. Код возврата не нулевой, если хоть одна операция
# вышла за бюджет.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# api-basic — базовые операции; data-queries — запросы к демо-датасету (ADR-0063);
# gis-tiles — тайлы слоя на демо-датасете (ADR-0064)
PROFILE="${KCHS_PERF_PROFILE:-api-basic}"
[[ -f "$ROOT/infra/perf/k6/$PROFILE.js" ]] || { echo "нет профиля k6: $PROFILE" >&2; exit 2; }
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.4.0}"
OUT_DIR="${KCHS_PERF_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/kchs-perf.XXXXXX")}"
mkdir -p "$OUT_DIR"

status=0
# host.docker.internal — адрес хоста из контейнера (в Linux его даёт host-gateway)
docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --add-host host.docker.internal:host-gateway \
  -v "$ROOT/infra/perf/k6:/scripts:ro" \
  -v "$OUT_DIR:/out" \
  -e KCHS_PERF_API -e KCHS_PERF_ADMIN -e KCHS_PERF_ADMIN_PASSWORD \
  -e KCHS_PERF_USER_PASSWORD -e KCHS_PERF_COOKIE -e KCHS_PERF_USERS \
  -e KCHS_PERF_RATE -e KCHS_PERF_DURATION -e KCHS_PERF_LOGIN_BUDGET_MS \
  -e KCHS_PERF_DATASET \
  -e KCHS_PERF_OUT=/out/summary.json \
  "$K6_IMAGE" run --quiet "/scripts/$PROFILE.js" | tee "$OUT_DIR/summary.txt" || status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Бюджеты API (k6, %s)\n\n```\n%s\n```\n' "$PROFILE" "$(cat "$OUT_DIR/summary.txt")" >> "$GITHUB_STEP_SUMMARY"
fi
echo "Отчёт k6: $OUT_DIR/summary.json"
exit "$status"
