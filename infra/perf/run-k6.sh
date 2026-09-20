#!/usr/bin/env bash
# Замер бюджетов производительности API (04-verification.md §4) профилем k6
# (infra/perf/k6/<профиль>.js). k6 запускается в Docker — ставить его не нужно.
#
# Профили стенда S1 (один сервер, демо-данные):
#   bash infra/perf/run-k6.sh                  # api-basic: базовые операции, api :3000
#   KCHS_PERF_PROFILE=data-queries bash infra/perf/run-k6.sh  # запросы к датасету 5 млн строк
#   KCHS_PERF_PROFILE=gis-tiles bash infra/perf/run-k6.sh     # векторные тайлы слоя (ADR-0064)
#   KCHS_PERF_API=http://host.docker.internal:8080/api/v1 bash infra/perf/run-k6.sh  # через web
#   KCHS_PERF_RATE=2 KCHS_PERF_DURATION=30s bash infra/perf/run-k6.sh               # мягче и короче
#
# Профили масштаба S2 (кластер, 15-admin-operations.md §3 и §8, ADR-0119):
#   KCHS_PERF_PROFILE=s2-workday   1000 одновременных сотрудников, Входящие и чаты
#   KCHS_PERF_PROFILE=s2-tiles     200 тайлов в секунду
#   KCHS_PERF_PROFILE=s2-analytics тяжёлые запросы к датасету 5 млн строк
#   KCHS_PERF_PROFILE=s2-mixed     всё сразу — так установка живёт на самом деле
#
# Любой профиль работает против произвольного адреса, а не только localhost:
#   KCHS_PERF_API=https://kchs.example.org/api/v1 \
#   KCHS_PERF_PROFILE=s2-mixed bash infra/perf/run-k6.sh
#   KCHS_PERF_INSECURE_TLS=1  — стенд с самоподписанным сертификатом
#
# Остальные параметры — KCHS_PERF_* в начале профиля (логины и пароли демо-данных,
# число сотрудников, доли операций, пороги). Любая переменная KCHS_PERF_* из
# окружения передаётся в контейнер k6 как есть. Профиль создаёт своё пространство
# «Нагрузочный профиль» с папками и сообщениями — на общем стенде это видно
# участникам. Итог — таблица p95 по операциям (и в сводке GitHub Actions); полный
# отчёт k6 в JSON — в KCHS_PERF_OUT_DIR. Код возврата не нулевой, если хоть одна
# операция вышла за бюджет.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="${KCHS_PERF_PROFILE:-api-basic}"
[[ -f "$ROOT/infra/perf/k6/$PROFILE.js" ]] || { echo "нет профиля k6: $PROFILE" >&2; exit 2; }
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.4.0}"
OUT_DIR="${KCHS_PERF_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/kchs-perf.XXXXXX")}"
mkdir -p "$OUT_DIR"

# Все KCHS_PERF_* окружения — в контейнер: у профилей S2 свои параметры, и
# перечислять их по одному значило бы править скрипт с каждым новым профилем.
# KCHS_PERF_OUT задаётся ниже принудительно: путь внутри контейнера.
env_args=()
while IFS='=' read -r name _; do
  [[ "$name" == KCHS_PERF_OUT || "$name" == KCHS_PERF_OUT_DIR ]] && continue
  env_args+=(-e "$name")
done < <(env | grep -E '^KCHS_PERF_[A-Z0-9_]+=' || true)

status=0
# host.docker.internal — адрес хоста из контейнера (в Linux его даёт host-gateway);
# для кластера адрес задаётся целиком в KCHS_PERF_API и это правило не мешает
docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --add-host host.docker.internal:host-gateway \
  -v "$ROOT/infra/perf/k6:/scripts:ro" \
  -v "$OUT_DIR:/out" \
  "${env_args[@]}" \
  -e KCHS_PERF_OUT=/out/summary.json \
  "$K6_IMAGE" run --quiet "/scripts/$PROFILE.js" | tee "$OUT_DIR/summary.txt" || status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Бюджеты API (k6, %s)\n\n```\n%s\n```\n' "$PROFILE" "$(cat "$OUT_DIR/summary.txt")" >> "$GITHUB_STEP_SUMMARY"
fi
echo "Отчёт k6: $OUT_DIR/summary.json"
exit "$status"
