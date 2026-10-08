#!/usr/bin/env bash
# История ЧС Комитета: исходники (таблицы Disaster, акты ущерба Word, сводка «10 сола»,
# геобаза ArcGIS, база ESTJ) → каталог загрузки и файл сверки. Руководство — README.md рядом.
#
#   bash infra/history/build-bundle.sh <каталог исходников> <каталог результата>
#
# В результате: Сверка.xlsx — для проверки владельцем; bundle/ — для загрузки
# (`kchs import-history`, на стенде показа — `demo-stand.sh history <каталог>/bundle`).
# Разбор идёт в образе движка платформы (Excel, Word, геоданные): KCHS_ENGINE_IMAGE или
# kchs/engine:${KCHS_IMAGE_TAG:-0.1.0}. Исходники только читаются.
set -euo pipefail

SRC="$(cd "${1:?укажите каталог исходников}" && pwd)"
mkdir -p "${2:?укажите каталог результата}"
OUT="$(cd "$2" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${KCHS_ENGINE_IMAGE:-kchs/engine:${KCHS_IMAGE_TAG:-0.1.0}}"

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "Нет образа $IMAGE — соберите движок (docker compose build engine) или задайте KCHS_ENGINE_IMAGE" >&2
  exit 1
}

for step in disaster damage gis review bundle; do
  echo "── $step ──"
  docker run --rm \
    -v "$SRC:/data:ro" \
    -v "$OUT:/out" \
    -v "$ROOT/infra/history:/tools:ro" \
    -v "$ROOT/apps/api/src/seed/territories.json:/seed/territories.json:ro" \
    -e PYTHONWARNINGS=ignore \
    --entrypoint python "$IMAGE" "/tools/$step.py"
done
echo
echo "Сверка: $OUT/Сверка.xlsx"
echo "Каталог загрузки: $OUT/bundle"
