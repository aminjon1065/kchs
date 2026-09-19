#!/usr/bin/env bash
# Векторная подложка kchs (07-gis-engine.md §5, ADR-0010, ADR-0066): Planetiler с профилем
# OpenMapTiles → PMTiles, манифест, шрифты (glyphs) и спрайты → загрузка в бакет тайлов.
#
#   bash infra/basemaps/build-pmtiles.sh     # Таджикистан + соседи на низких зумах
#   KCHS_BASEMAP_UPLOAD=0 bash infra/basemaps/build-pmtiles.sh   # только собрать
#   KCHS_BASEMAP_AREA=kyrgyzstan KCHS_BASEMAP_NAME="…" KCHS_BASEMAP_BOUNDS=… bash …
#   KCHS_BASEMAP_OCEAN=1 bash …   # с полигонами морей (+930 МБ) — для территорий у моря
#
# Кэш — seeds/.cache/basemaps (в .gitignore): OSM ≈ 50 МБ, Natural Earth ≈ 435 МБ, линии
# подписей озёр ≈ 80 МБ, шрифты ≈ 75 МБ — всего ≈ 620 МБ. Повторный запуск берёт источники из
# кэша, KCHS_BASEMAP_REFRESH=1 скачивает свежие. Загрузка — `pnpm kchs basemaps upload`
# (переменные S3_* и базы из .env): файлы в бакет тайлов, затем регистрация в реестре.
# Установка в контейнерах — 15-admin-operations.md, «Базовые карты».
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/infra/basemaps"
CACHE="${KCHS_BASEMAP_CACHE:-$ROOT/seeds/.cache/basemaps}"
AREA="${KCHS_BASEMAP_AREA:-tajikistan}"
KEY="${KCHS_BASEMAP_KEY:-$AREA}"
NAME="${KCHS_BASEMAP_NAME:-OpenStreetMap — Таджикистан}"
# Страна и соседи: подробные данные OSM — только в выгрузке, соседей на низких зумах даёт
# Natural Earth; тайлы вне данных пустые и в архив не попадают
BOUNDS="${KCHS_BASEMAP_BOUNDS:-60,33,81,45}"
MAXZOOM="${KCHS_BASEMAP_MAXZOOM:-14}"
MEMORY="${KCHS_BASEMAP_MEMORY:-4g}"
VERSION="${KCHS_BASEMAP_VERSION:-$(date -u +%Y-%m-%d)}"
IMAGE="${PLANETILER_IMAGE:-ghcr.io/onthegomap/planetiler:0.10.2}"
FONTS_URL="${KCHS_BASEMAP_FONTS_URL:-https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip}"
# Шрифты подписей: латиница и кириллица (с таджикскими буквами) — в диапазонах Noto Sans
FONTSTACKS="${KCHS_BASEMAP_FONTSTACKS:-Noto Sans Regular,Noto Sans Bold,Noto Sans Italic}"

OUT="$CACHE/out"
mkdir -p "$CACHE/sources" "$OUT/$KEY"

# ─── 1. Полигоны морей ─────────────────────────────────────────────────────
water="/data/sources/water-polygons-split-3857.zip"
if [[ "${KCHS_BASEMAP_OCEAN:-0}" != "1" ]]; then
  python3 "$HERE/empty_water_polygons.py" "$CACHE/sources/water-polygons-empty.zip"
  water="/data/sources/water-polygons-empty.zip"
fi

# ─── 2. Тайлы ──────────────────────────────────────────────────────────────
refresh=()
if [[ "${KCHS_BASEMAP_REFRESH:-0}" == "1" ]]; then refresh=(--refresh-sources); fi
started=$(date +%s)
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx$MEMORY" \
  -v "$CACHE:/data" \
  "$IMAGE" \
  --download --download-dir=/data/sources \
  --area="$AREA" --bounds="$BOUNDS" \
  --maxzoom="$MAXZOOM" --render-maxzoom="$MAXZOOM" \
  --languages=ru,tg,en \
  --water-polygons-path="$water" \
  --output="/data/out/$KEY/$VERSION.pmtiles" --force \
  ${refresh[@]+"${refresh[@]}"}
echo "Planetiler: $(($(date +%s) - started)) с"

python3 "$HERE/pmtiles_manifest.py" "$OUT/$KEY/$VERSION.pmtiles" "$KEY" "$VERSION" "$NAME" \
  > "$OUT/$KEY/manifest.json"

# ─── 3. Шрифты и спрайты ───────────────────────────────────────────────────
fonts="$CACHE/sources/fonts-v2.0.zip"
if [[ ! -s "$fonts" || "${KCHS_BASEMAP_REFRESH:-0}" == "1" ]]; then
  curl -fsSL --retry 3 -o "$fonts.part" "$FONTS_URL"
  mv "$fonts.part" "$fonts"
fi
python3 - "$fonts" "$OUT/glyphs" "$FONTSTACKS" <<'PY'
import sys, zipfile
from pathlib import Path

archive, target, stacks = sys.argv[1], Path(sys.argv[2]), sys.argv[3].split(",")
with zipfile.ZipFile(archive) as z:
    for stack in stacks:
        names = [n for n in z.namelist() if n.split("/")[-2:-1] == [stack] and n.endswith(".pbf")]
        if not names:
            sys.exit(f"в архиве шрифтов нет «{stack}»")
        for name in names:
            path = target / stack / Path(name).name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(z.read(name))
print(f"glyphs: {', '.join(stacks)}")
PY
python3 "$HERE/sprites.py" "$OUT/sprites"

du -sh "$OUT/$KEY/$VERSION.pmtiles" "$OUT/glyphs" "$OUT/sprites" | sed 's|'"$OUT"'/||'

# ─── 4. Загрузка в хранилище ───────────────────────────────────────────────
if [[ "${KCHS_BASEMAP_UPLOAD:-1}" == "1" ]]; then
  (cd "$ROOT" && pnpm --silent kchs basemaps upload "$OUT" --key "$KEY")
fi
