"""Геобаза ArcGIS «Карта связи КЧС и ГО» → /out/gis/<слой>.gpkg (EPSG:4326, 2D) и сверка.

Названия слоёв и полей — человеческие (русские), поля ArcGIS (Shape_Length, FID_) убраны.
Границы районов сверяются со справочником территорий: справочник не заменяется.
"""

from __future__ import annotations

import csv
import os
import sys

import numpy as np
import pyogrio
import pyogrio.raw
import shapely
from pyproj import Transformer

sys.path.insert(0, "/tools")
from common import Gazetteer, clean, load_territories  # noqa: E402

SRC = "/data/Tajikistan data/Data.gdb"
OUT = "/out/gis/"

# слой ArcGIS → (файл, название ru, поля: исходное → новое)
LAYERS = {
    "Communication_network_": ("communication_network", "Сеть связи КЧС и ГО", {
        "Тип_оборудования": "equipment_type", "Названия_оборудования": "equipment_name",
        "Область": "region", "Район__Город_": "district", "Джамоат": "jamoat",
        "Село__посёлок__город_": "settlement", "H": "altitude_m"}),
    "Зона_охвата_связи": ("coverage_zones", "Зоны охвата связи", {"Названия_оборудования": "equipment_name"}),
    "Settlement": ("settlements", "Населённые пункты", {"Name_ru": "name_ru", "Name_tj": "name_tg", "Text": "label"}),
    "Rivers": ("rivers", "Реки", {"TEXT": "name"}),
    "Lakes_and_reservoir": ("lakes", "Озёра и водохранилища", {"TEXT": "name"}),
    "Glaciers": ("glaciers", "Ледники", {"name_rus": "name_ru", "name_eng": "name_en", "Area": "area_km2",
                                          "Pulsating": "pulsating", "note": "note"}),
    "International_higway": ("highways", "Международные автодороги", {}),
    "Secondary_roads": ("secondary_roads", "Второстепенные дороги", {}),
    "Reilway": ("railway", "Железная дорога", {}),
    "Tunnel": ("tunnels", "Тоннели", {}),
    "District_border": ("district_borders", "Границы районов (ArcGIS)", {"Name": "name_tg", "Eng__Name": "name_en",
                                                                          "Rus_Name": "name_ru", "Region": "region"}),
    "Regional_border": ("regional_borders", "Границы областей", {}),
    "Republican_border": ("state_border", "Государственная граница", {}),
}

to_wgs = Transformer.from_crs("EPSG:32642", "EPSG:4326", always_xy=True)


def reproject(geoms: np.ndarray) -> np.ndarray:
    geoms = shapely.force_2d(geoms)
    coords = shapely.get_coordinates(geoms)
    x, y = to_wgs.transform(coords[:, 0], coords[:, 1])
    return shapely.make_valid(shapely.set_coordinates(geoms, np.column_stack([x, y])))


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    report = []
    territories = load_territories()
    gaz = Gazetteer(territories)
    for layer, (name, title, rename) in LAYERS.items():
        meta, _, geometry, field_data = pyogrio.raw.read(SRC, layer=layer)
        geoms = reproject(shapely.from_wkb(geometry))
        keep_names, keep_data = [], []
        for field, data in zip(meta["fields"], field_data):
            if field not in rename:
                continue
            values = np.array([clean(v) if isinstance(v, str) else v for v in data], dtype=object)
            keep_names.append(rename[field])
            keep_data.append(values)
        if not keep_names:
            keep_names, keep_data = ["layer"], [np.array([title] * len(geoms), dtype=object)]
        nonempty = ~shapely.is_empty(geoms)
        geoms = geoms[nonempty]
        keep_data = [d[nonempty] for d in keep_data]
        kinds = sorted({shapely.get_type_id(g) for g in geoms})
        geom_type = {0: "Point", 1: "LineString", 3: "Polygon", 4: "MultiPoint", 5: "MultiLineString",
                     6: "MultiPolygon", 7: "GeometryCollection"}
        gtype = "Unknown" if len(kinds) > 1 else geom_type[kinds[0]]
        if set(kinds) <= {3, 6}:
            geoms = np.array([g if g.geom_type == "MultiPolygon" else shapely.MultiPolygon([g]) for g in geoms], dtype=object)
            gtype = "MultiPolygon"
        elif set(kinds) <= {1, 5}:
            geoms = np.array([g if g.geom_type == "MultiLineString" else shapely.MultiLineString([g]) for g in geoms], dtype=object)
            gtype = "MultiLineString"
        path = f"{OUT}{name}.gpkg"
        if os.path.exists(path):
            os.remove(path)
        pyogrio.raw.write(path, geometry=shapely.to_wkb(geoms), field_data=keep_data, fields=keep_names,
                          crs="EPSG:4326", geometry_type=gtype, layer=name, driver="GPKG", encoding="UTF-8")
        bounds = shapely.total_bounds(geoms)
        report.append([layer, f"{name}.gpkg", title, len(geoms), gtype, ", ".join(keep_names),
                       f"{bounds[0]:.2f},{bounds[1]:.2f} — {bounds[2]:.2f},{bounds[3]:.2f}"])

    # Сверка границ районов ArcGIS со справочником (только имена: геометрию справочника не трогаем)
    meta, _, _, data = pyogrio.raw.read(SRC, layer="District_border")
    fields = list(meta["fields"])
    names_ru = data[fields.index("Rus_Name")]
    names_tg = data[fields.index("Name")]
    matched, missing = [], []
    for ru, tg in zip(names_ru, names_tg):
        place = gaz.place("", clean(ru) or clean(tg), 2026)
        (matched if place.level == "district" else missing).append(f"{clean(ru)} / {clean(tg)}")
    with open("/out/review_gis.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["слой ArcGIS", "файл", "название", "объектов", "геометрия", "поля", "охват (долгота, широта)"])
        w.writerows(report)
        w.writerow([])
        w.writerow(["Границы районов ArcGIS: совпали со справочником", len(matched), "не совпали", len(missing), "; ".join(missing)])
    for row in report:
        print(row[:5])
    print("районов ArcGIS:", len(names_ru), "узнаны:", len(matched), "нет в справочнике:", missing)


if __name__ == "__main__":
    main()
