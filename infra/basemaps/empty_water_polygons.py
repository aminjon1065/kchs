"""Пустой shapefile морских полигонов (EPSG:3857) в zip — для стран без выхода к морю.

Профиль OpenMapTiles в Planetiler требует источник `water_polygons` (930 МБ
полигонов океанов); у Таджикистана моря нет, а озёра и реки приходят из OSM и
Natural Earth. Пустой набор той же структуры экономит загрузку (ADR-0066).
Только стандартная библиотека: заголовки .shp/.shx/.dbf и .prj пишутся вручную.

    python3 empty_water_polygons.py <путь к zip>
"""

import struct
import sys
import zipfile
from pathlib import Path

POLYGON = 5
# ESRI WKT веб-Меркатора (как в water-polygons-split-3857)
PRJ = (
    'PROJCS["WGS_84_Pseudo_Mercator",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],'
    'UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator"],'
    'PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],'
    'PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],'
    'UNIT["Meter",1.0]]'
)


def shape_header() -> bytes:
    """Заголовок .shp/.shx без записей: длина файла — 50 слов по 16 бит."""
    head = struct.pack(">7i", 9994, 0, 0, 0, 0, 0, 50)
    return head + struct.pack("<2i", 1000, POLYGON) + struct.pack("<8d", *([0.0] * 8))


def dbf() -> bytes:
    """dBase III без записей с одним полем FID N(10)."""
    fields = [(b"FID", b"N", 10)]
    header_length = 32 + 32 * len(fields) + 1
    record_length = 1 + sum(length for _, _, length in fields)
    out = struct.pack("<BBBBIHH20x", 0x03, 126, 9, 19, 0, header_length, record_length)
    for name, kind, length in fields:
        out += struct.pack("<11sc4xBB14x", name.ljust(11, b"\0"), kind, length, 0)
    return out + b"\r" + b"\x1a"


def main(target: str) -> None:
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    folder = "water-polygons-split-3857"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{folder}/water_polygons.shp", shape_header())
        archive.writestr(f"{folder}/water_polygons.shx", shape_header())
        archive.writestr(f"{folder}/water_polygons.dbf", dbf())
        archive.writestr(f"{folder}/water_polygons.prj", PRJ)
        archive.writestr(f"{folder}/water_polygons.cpg", "UTF-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("использование: empty_water_polygons.py <zip>")
    main(sys.argv[1])
