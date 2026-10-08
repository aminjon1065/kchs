#!/usr/bin/env bash
# Отмывка рельефа для векторной подложки (ADR-0195): GeoTIFF в оттенках серого → растровый
# PMTiles рядом с архивом сборки, блок `relief` в её манифесте → загрузка в бакет тайлов.
#
#   bash infra/basemaps/build-relief.sh <отмывка.tif>
#   KCHS_BASEMAP_UPLOAD=0 bash infra/basemaps/build-relief.sh <отмывка.tif>   # только собрать
#
# Сборка подложки (build-pmtiles.sh) уже должна лежать в кэше: рельеф дописывается в её
# манифест. build-pmtiles.sh вызывает этот скрипт сам, если задан KCHS_BASEMAP_RELIEF.
# Масштабы — KCHS_RELIEF_MINZOOM (5) и KCHS_RELIEF_MAXZOOM (11: ~60 м на пиксель на широте
# Таджикистана, у отмывки Комитета `hill.tif` — 70 м; крупнее карта растягивает z11).
# Разбор — в образе движка (GDAL, numpy, Pillow): KCHS_ENGINE_IMAGE или
# kchs/engine:${KCHS_IMAGE_TAG:-0.1.0}.
set -euo pipefail

SOURCE="${1:?укажите файл отмывки (GeoTIFF)}"
[[ -f "$SOURCE" ]] || { echo "Нет файла $SOURCE" >&2; exit 1; }
SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
SOURCE_NAME="$(basename "$SOURCE")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="${KCHS_BASEMAP_CACHE:-$ROOT/seeds/.cache/basemaps}"
AREA="${KCHS_BASEMAP_AREA:-tajikistan}"
KEY="${KCHS_BASEMAP_KEY:-$AREA}"
OUT="$CACHE/out"
IMAGE="${KCHS_ENGINE_IMAGE:-kchs/engine:${KCHS_IMAGE_TAG:-0.1.0}}"

[[ -f "$OUT/$KEY/manifest.json" ]] || {
  echo "Нет сборки подложки $OUT/$KEY — сначала infra/basemaps/build-pmtiles.sh" >&2
  exit 1
}
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "Нет образа $IMAGE — соберите движок (docker compose build engine) или задайте KCHS_ENGINE_IMAGE" >&2
  exit 1
}

started=$(date +%s)
# Файлы — от имени пользователя хоста: на Linux каталог кэша иначе не записать
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$SOURCE_DIR:/source:ro" \
  -v "$OUT:/out" \
  -v "$ROOT/infra/basemaps:/tools:ro" \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --entrypoint python "$IMAGE" /tools/relief.py "/source/$SOURCE_NAME" /out \
  --key "$KEY" \
  --min-zoom "${KCHS_RELIEF_MINZOOM:-5}" \
  --max-zoom "${KCHS_RELIEF_MAXZOOM:-11}"
echo "Рельеф: $(($(date +%s) - started)) с"

if [[ "${KCHS_BASEMAP_UPLOAD:-1}" == "1" ]]; then
  (cd "$ROOT" && pnpm --silent kchs basemaps upload "$OUT" --key "$KEY")
fi
