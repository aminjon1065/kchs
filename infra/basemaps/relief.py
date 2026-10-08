"""Отмывка рельефа (GeoTIFF в оттенках серого) → растровый PMTiles для подложки (ADR-0195).

  python relief.py <отмывка.tif> <каталог сборки подложки> [--key tajikistan] [--max-zoom 11]

Отмывка перепроецируется в Web Mercator по сетке тайлов `max-zoom` (gdalwarp -tap), тени
становятся полупрозрачным чёрным, освещённые склоны — полупрозрачным белым, ровные места —
прозрачными: рельеф ложится поверх векторной подложки, не заливая её серым. Мелкие масштабы —
усреднением (с учётом прозрачности). Архив `relief-<версия>-<sha8>.pmtiles` кладётся рядом с
векторным, в манифест сборки дописывается блок `relief`. Нужны GDAL (gdalwarp, gdal_translate, gdalinfo), numpy и Pillow —
всё есть в образе движка.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import os
import struct
import subprocess
import tempfile

import numpy as np
from PIL import Image

ORIGIN = 20037508.342789244  # половина окружности Web Mercator, м
TILE = 256


def resolution(zoom: int) -> float:
    return 2 * ORIGIN / (TILE * 2**zoom)


def lon(x: float) -> float:
    return x / ORIGIN * 180.0


def lat(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y / ORIGIN * math.pi)) - math.pi / 2)


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


# ── PMTiles v3: запись (спецификация github.com/protomaps/PMTiles/blob/main/spec/v3) ──


def hilbert_id(z: int, x: int, y: int) -> int:
    acc = sum(4**i for i in range(z))
    n = 2**z
    d = 0
    s = n // 2
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        s //= 2
    return acc + d


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def directory(entries: list[tuple[int, int, int, int]]) -> bytes:
    """Записи (tile_id, offset, length, run_length) → сжатый каталог."""
    out = bytearray(varint(len(entries)))
    last = 0
    for tile_id, _, _, _ in entries:
        out += varint(tile_id - last)
        last = tile_id
    for _, _, _, run_length in entries:
        out += varint(run_length)
    for _, _, length, _ in entries:
        out += varint(length)
    for i, (_, offset, _, _) in enumerate(entries):
        prev = entries[i - 1] if i > 0 else None
        if prev and offset == prev[1] + prev[2]:
            out += varint(0)
        else:
            out += varint(offset + 1)
    return gzip.compress(bytes(out), mtime=0)


def write_pmtiles(path: str, tiles: dict[tuple[int, int, int], bytes], meta: dict, bounds, zooms) -> int:
    ordered = sorted(((hilbert_id(z, x, y), data) for (z, x, y), data in tiles.items()), key=lambda t: t[0])
    data = bytearray()
    entries = []
    for tile_id, blob in ordered:
        entries.append((tile_id, len(data), len(blob), 1))
        data += blob
    root = directory(entries)
    leaves = b""
    if len(root) > 16384 - 127:
        # Корень не влезает в первые 16 КБ: листовые каталоги по 4096 записей
        chunks = [entries[i:i + 4096] for i in range(0, len(entries), 4096)]
        leaf_entries, blob = [], bytearray()
        for chunk in chunks:
            leaf = directory(chunk)
            leaf_entries.append((chunk[0][0], len(blob), len(leaf), 0))
            blob += leaf
        root, leaves = directory(leaf_entries), bytes(blob)
    metadata = gzip.compress(json.dumps(meta, ensure_ascii=False).encode(), mtime=0)
    root_off = 127
    meta_off = root_off + len(root)
    leaf_off = meta_off + len(metadata)
    data_off = leaf_off + len(leaves)
    min_lon, min_lat, max_lon, max_lat = bounds
    min_z, max_z = zooms
    header = b"PMTiles" + struct.pack(
        "<BQQQQQQQQQQQBBBBBBiiiiBii",
        3,
        root_off, len(root), meta_off, len(metadata), leaf_off, len(leaves), data_off, len(data),
        len(entries), len(entries), len(entries),
        1,  # clustered
        2,  # internal compression: gzip
        1,  # tile compression: none (PNG сжат сам)
        2,  # tile type: png
        min_z, max_z,
        round(min_lon * 1e7), round(min_lat * 1e7), round(max_lon * 1e7), round(max_lat * 1e7),
        (min_z + max_z) // 2,
        round((min_lon + max_lon) / 2 * 1e7), round((min_lat + max_lat) / 2 * 1e7),
    )
    assert len(header) == 127, len(header)
    with open(path, "wb") as f:
        f.write(header + root + metadata + leaves + bytes(data))
    return len(entries)


# ── Отмывка → тайлы ─────────────────────────────────────────────────────────────


def shade(gray: np.ndarray, nodata: int) -> tuple[np.ndarray, np.ndarray]:
    """Серая отмывка → (яркость 0/255, непрозрачность): тени — чёрным, свет — белым."""
    valid = gray != nodata
    flat = float(np.median(gray[valid])) if valid.any() else 180.0
    g = gray.astype(np.float32)
    dark = np.clip((flat - g) / max(flat, 1.0), 0, 1)
    light = np.clip((g - flat) / max(254.0 - flat, 1.0), 0, 1)
    alpha = np.where(g < flat, dark * 255, light * 255 * 0.55)
    alpha = np.where(valid, alpha, 0).astype(np.float32)
    lum = np.where(g < flat, 0, 255).astype(np.float32)
    # Предумноженная яркость: при усреднении для мелких масштабов цвета не «грязнятся»
    return lum * alpha / 255.0, alpha


def encode(lum_p: np.ndarray, alpha: np.ndarray) -> bytes | None:
    a = np.clip(np.rint(alpha), 0, 255).astype(np.uint8)
    if not a.any():
        return None
    lum = np.where(alpha > 0, lum_p * 255.0 / np.maximum(alpha, 1e-6), 0)
    image = Image.fromarray(np.dstack([np.clip(np.rint(lum), 0, 255).astype(np.uint8), a]), "LA")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def downsample(arr: np.ndarray) -> np.ndarray:
    h, w = arr.shape
    arr = np.pad(arr, ((0, h % 2), (0, w % 2)))
    return arr.reshape(arr.shape[0] // 2, 2, arr.shape[1] // 2, 2).mean(axis=(1, 3))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("build")
    parser.add_argument("--key", default="tajikistan")
    parser.add_argument("--max-zoom", type=int, default=11)
    parser.add_argument("--min-zoom", type=int, default=5)
    args = parser.parse_args()

    manifest_path = os.path.join(args.build, args.key, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    res = resolution(args.max_zoom)

    with tempfile.TemporaryDirectory() as tmp:
        warped = os.path.join(tmp, "warped.tif")
        run("gdalwarp", "-q", "-t_srs", "EPSG:3857", "-tr", str(res), str(res), "-tap",
            "-r", "bilinear", "-srcnodata", "255", "-dstnodata", "255", "-ot", "Byte",
            "-co", "COMPRESS=NONE", args.source, warped)
        info = json.loads(run("gdalinfo", "-json", warped))
        gt = info["geoTransform"]
        width, height = info["size"]
        raw = os.path.join(tmp, "warped.raw")
        run("gdal_translate", "-q", "-of", "ENVI", warped, raw)
        gray = np.fromfile(raw, dtype=np.uint8).reshape(height, width)

    # Пиксель растра → глобальный пиксель сетки max-zoom (выровнено gdalwarp -tap)
    col0 = round((gt[0] + ORIGIN) / res)
    row0 = round((ORIGIN - gt[3]) / res)
    lum_p, alpha = shade(gray, 255)
    del gray

    tiles: dict[tuple[int, int, int], bytes] = {}
    for zoom in range(args.max_zoom, args.min_zoom - 1, -1):
        h, w = alpha.shape
        tx0, ty0 = col0 // TILE, row0 // TILE
        tx1, ty1 = (col0 + w - 1) // TILE, (row0 + h - 1) // TILE
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                # Окно тайла в координатах массива (с полями за краем данных)
                x0, y0 = tx * TILE - col0, ty * TILE - row0
                a = np.zeros((TILE, TILE), np.float32)
                lp = np.zeros((TILE, TILE), np.float32)
                sx0, sy0 = max(x0, 0), max(y0, 0)
                sx1, sy1 = min(x0 + TILE, w), min(y0 + TILE, h)
                if sx1 <= sx0 or sy1 <= sy0:
                    continue
                a[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = alpha[sy0:sy1, sx0:sx1]
                lp[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = lum_p[sy0:sy1, sx0:sx1]
                blob = encode(lp, a)
                if blob:
                    tiles[(zoom, tx, ty)] = blob
        print(f"масштаб {zoom}: тайлов {sum(1 for k in tiles if k[0] == zoom)}", flush=True)
        if zoom > args.min_zoom:
            # Следующий масштаб: вдвое мельче; начало сетки — с чётного пикселя
            pad_x, pad_y = col0 % 2, row0 % 2
            alpha = downsample(np.pad(alpha, ((pad_y, 0), (pad_x, 0))))
            lum_p = downsample(np.pad(lum_p, ((pad_y, 0), (pad_x, 0))))
            col0, row0 = (col0 - pad_x) // 2, (row0 - pad_y) // 2

    corners = [gt[0], gt[3] + gt[5] * height, gt[0] + gt[1] * width, gt[3]]
    bounds = [
        round(lon(corners[0]), 5), round(lat(corners[1]), 5),
        round(lon(corners[2]), 5), round(lat(corners[3]), 5),
    ]

    version = manifest["version"]
    folder = os.path.join(args.build, args.key)
    staging = os.path.join(folder, "relief.pmtiles.tmp")
    count = write_pmtiles(staging, tiles, {
        "name": "Отмывка рельефа", "format": "png", "type": "overlay",
        "description": f"Отмывка рельефа из {os.path.basename(args.source)}",
        "attribution": "КЧС и ГО РТ",
    }, bounds, (args.min_zoom, args.max_zoom))
    with open(staging, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    # API отдаёт архив с «immutable»: новое содержимое — новое имя (часть SHA-256)
    name = f"relief-{version}-{sha[:8]}.pmtiles"
    path = os.path.join(folder, name)
    for old in os.listdir(folder):
        if old.startswith("relief-") and old.endswith(".pmtiles") and old != name:
            os.remove(os.path.join(folder, old))
    os.replace(staging, path)
    manifest["relief"] = {
        "file": name, "bytes": os.path.getsize(path), "sha256": sha,
        "minZoom": args.min_zoom, "maxZoom": args.max_zoom, "bounds": bounds, "tiles": count,
        "attribution": "КЧС и ГО РТ",
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"{name}: тайлов {count}, {os.path.getsize(path) / 1e6:.1f} МБ, охват {bounds}")


if __name__ == "__main__":
    main()
