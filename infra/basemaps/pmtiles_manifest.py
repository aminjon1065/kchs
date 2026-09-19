"""Манифест векторной подложки по заголовку PMTiles v3 (только стандартная библиотека).

API читает манифест из хранилища, чтобы зарегистрировать подложку, не открывая
сам архив: границы, центр, зумы, слои схемы, атрибуция, размер и SHA-256.

    python3 pmtiles_manifest.py <файл.pmtiles> <ключ> <версия> [название] > manifest.json
"""

import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

HEADER = struct.Struct("<7sB QQ QQ QQ QQ QQQ BBBB BB iiii B ii")
COMPRESSION = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}
TILE_TYPES = {0: "unknown", 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif", 6: "mlt"}


def read_manifest(path: Path, key: str, version: str, name: str) -> dict[str, object]:
    with path.open("rb") as stream:
        raw = stream.read(HEADER.size)
        values = HEADER.unpack(raw)
        magic, spec = values[0], values[1]
        if magic != b"PMTiles" or spec != 3:
            raise SystemExit(f"{path}: не PMTiles v3")
        (
            _root_offset,
            _root_length,
            metadata_offset,
            metadata_length,
            _leaf_offset,
            _leaf_length,
            _data_offset,
            _data_length,
            addressed,
            _entries,
            _contents,
        ) = values[2:13]
        _clustered, internal, tile_compression, tile_type = values[13:17]
        min_zoom, max_zoom = values[17:19]
        min_lon, min_lat, max_lon, max_lat = (value / 1e7 for value in values[19:23])
        center_zoom = values[23]
        center_lon, center_lat = (value / 1e7 for value in values[24:26])
        stream.seek(metadata_offset)
        blob = stream.read(metadata_length)
    if COMPRESSION.get(internal) == "gzip":
        blob = gzip.decompress(blob)
    metadata = json.loads(blob.decode("utf-8")) if blob else {}
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return {
        "format": "kchs-basemap/1",
        "key": key,
        "name": name,
        "kind": "vector",
        "schema": "openmaptiles",
        "version": version,
        "file": f"{version}.pmtiles",
        "bytes": path.stat().st_size,
        "sha256": digest.hexdigest(),
        "tileType": TILE_TYPES.get(tile_type, "unknown"),
        "tileCompression": COMPRESSION.get(tile_compression, "unknown"),
        "minZoom": min_zoom,
        "maxZoom": max_zoom,
        "bounds": [min_lon, min_lat, max_lon, max_lat],
        "center": [center_lon, center_lat, center_zoom],
        "tiles": addressed,
        "attribution": metadata.get("attribution"),
        "layers": sorted(layer.get("id") for layer in metadata.get("vector_layers", [])),
    }


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit("использование: pmtiles_manifest.py <файл> <ключ> <версия> [название]")
    target = Path(sys.argv[1])
    title = sys.argv[4] if len(sys.argv) > 4 else sys.argv[2]
    manifest = read_manifest(target, sys.argv[2], sys.argv[3], title)
    json.dump(manifest, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
