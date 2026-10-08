"""Пакет загрузки истории КЧС: /out/bundle/ — манифест, данные JSON, слои, архив исходников.

Загрузчик платформы (`kchs import-history <каталог>`) читает только этот каталог: его можно
перенести на другой стенд (VPS) целиком.
"""

from __future__ import annotations

import csv
import glob
import json
import os
import shutil
import zipfile

OUT = "/out/"
BUNDLE = "/out/bundle/"
TEXT_MAX = 1000


def read(name: str) -> list[dict]:
    with open(OUT + name, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def i(v: str):
    return int(float(v)) if v not in ("", None) else None


def f(v: str):
    return round(float(v), 2) if v not in ("", None) else None


def b(v: str):
    return v == "true"


def s(v: str):
    return v if v else None


def incidents() -> list[dict]:
    rows = []
    for r in read("incidents.csv"):
        text = r["description"]
        full = text if len(text) > TEXT_MAX else None
        short = (text[: TEXT_MAX - 1].rstrip() + "…") if full else text
        rows.append({
            "code": r["code"], "occurred_at": r["occurred_at"], "date_precision": r["date_precision"],
            "date_text": s(r["date_text"]), "type_code": r["type_code"], "type_raw": s(r["type_raw"][:TEXT_MAX]),
            "territory": r["territory"], "territory_note": s(r["territory_note"]),
            "place": s(r["place"][:TEXT_MAX]), "occurrences": i(r["occurrences"]) or 1,
            "description": s(short), "full_text": full,
            "deaths": i(r["deaths"]), "deaths_from_text": b(r["deaths_from_text"]),
            "injured": i(r["injured"]), "rescued": i(r["rescued"]), "bodies_recovered": i(r["bodies_recovered"]),
            "rescue_team": b(r["rescue_team"]), "affected_text": s(r["affected_text"]),
            "damage": f(r["damage"]), "damage_raw": s(r["damage_raw"][:TEXT_MAX]),
            "needs_raw": s(r["needs_raw"][:TEXT_MAX]), "info_source": s(r["info_source"][:TEXT_MAX]),
            "legacy_code": s(r["legacy_code"]), "origin": r["origin"][:TEXT_MAX],
        })
    return rows


def damage() -> list[dict]:
    return [{
        "code": r["code"], "incident_code": s(r["incident_code"]), "event_date": s(r["event_date"]),
        "date_precision": r["date_precision"], "year": i(r["year"]), "type_code": r["type_code"],
        "cause": s(r["cause"][:TEXT_MAX]), "territory": r["territory"], "territory_note": s(r["territory_note"]),
        "place_raw": s(r["place_raw"][:TEXT_MAX]), "decision_date": s(r["decision_date"]), "decision_no": s(r["decision_no"]),
        "houses": i(r["houses"]), "houses_destroyed": i(r["houses_destroyed"]), "schools": i(r["schools"]),
        "medical": i(r["medical"]), "bridges": i(r["bridges"]), "roads_km": f(r["roads_km"]),
        "power_km": f(r["power_km"]), "canals_km": f(r["canals_km"]), "livestock": i(r["livestock"]),
        "deaths": i(r["deaths"]), "damage": f(r["damage"]), "damage_text": s(r["damage_text"][:TEXT_MAX]),
        "text": r["text"], "origin": r["origin"],
    } for r in read("damage_assessments.csv")]


def stats() -> list[dict]:
    return [{"year": i(r["year"]), "category": r["category"], "category_name": r["category_name"],
             "count": i(r["count"]), "deaths": i(r["deaths"]), "damage": f(r["damage"])} for r in read("stats_10y.csv")]


def types() -> list[dict]:
    return [{"code": r["code"], "name": r["name"], "name_tg": r["name_tg"], "group_name": r["group_name"],
             "report_category": r["report_category_name"]} for r in read("incident_types.csv")]


def style(geometry: str, **extra) -> dict:
    return {"version": 1, "geometry": geometry, **extra}


LAYERS = [
    # снизу вверх, как в проекте ArcMap
    ("district_borders", "Границы районов (ArcGIS)", False,
     style("polygon", renderer={"kind": "simple", "color": "neutral"},
           polygon={"fillOpacity": 0, "outline": {"width": 0.8, "color": "neutral"}},
           label={"field": "name_ru", "minZoom": 8, "size": 11})),
    ("glaciers", "Ледники", True,
     style("polygon", renderer={"kind": "simple", "color": "#d9edf7"},
           polygon={"fillOpacity": 0.7, "outline": {"width": 0.3, "color": "#9cc9e3"}},
           popup={"title": "{{name_ru}}", "fields": ["name_ru", "area_km2", "pulsating", "note"], "actions": []},
           minZoom=6)),
    ("lakes", "Озёра и водохранилища", True,
     style("polygon", renderer={"kind": "simple", "color": "info"},
           polygon={"fillOpacity": 0.55, "outline": {"width": 0.5, "color": "info"}},
           label={"field": "name", "minZoom": 9, "size": 11})),
    ("rivers", "Реки", True,
     style("line", renderer={"kind": "simple", "color": "info"}, line={"width": 1.2, "cap": "round"},
           label={"field": "name", "minZoom": 10, "size": 10, "placement": "line"})),
    ("secondary_roads", "Второстепенные дороги", True,
     style("line", renderer={"kind": "simple", "color": "neutral"}, line={"width": 1, "cap": "round"}, minZoom=7)),
    ("highways", "Международные автодороги", True,
     style("line", renderer={"kind": "simple", "color": "warning"}, line={"width": 2.5, "cap": "round"})),
    ("railway", "Железная дорога", True,
     style("line", renderer={"kind": "simple", "color": "#555555"}, line={"width": 1.5, "dash": [4, 2], "cap": "butt"})),
    ("regional_borders", "Границы областей", True,
     style("line", renderer={"kind": "simple", "color": "categorical.5"}, line={"width": 1.8, "dash": [6, 3], "cap": "butt"})),
    ("state_border", "Государственная граница", True,
     style("line", renderer={"kind": "simple", "color": "danger"}, line={"width": 2.5, "cap": "butt"})),
    ("tunnels", "Тоннели", True,
     style("point", renderer={"kind": "simple", "color": "#333333"}, point={"shape": "square", "size": 7})),
    ("settlements", "Населённые пункты", True,
     style("point", renderer={"kind": "simple", "color": "#666666"}, point={"shape": "circle", "size": 4},
           label={"field": "name_ru", "minZoom": 9, "size": 11},
           popup={"title": "{{name_ru}}", "fields": ["name_ru", "name_tg"], "actions": []}, minZoom=7)),
    ("coverage_zones", "Зоны охвата связи", True,
     style("polygon", renderer={"kind": "simple", "color": "categorical.3"},
           polygon={"fillOpacity": 0.15, "outline": {"width": 1, "color": "categorical.3"}},
           popup={"title": "{{equipment_name}}", "fields": ["equipment_name"], "actions": []})),
    ("communication_network", "Сеть связи КЧС и ГО", True,
     style("point", renderer={"kind": "categorized", "field": "equipment_type", "categories": [],
                              "other": {"color": "categorical.1"}},
           point={"shape": "triangle", "size": 10},
           label={"field": "equipment_name", "minZoom": 9, "size": 11},
           popup={"title": "{{equipment_name}}",
                  "fields": ["equipment_type", "equipment_name", "region", "district", "jamoat", "settlement", "altitude_m"],
                  "actions": []})),
]

ARCHIVE = [
    ("Акты оценки ущерба 2013–2026 (Word)", "ЧС/*.docx"),
    ("Реестр Disaster 1992–2020 (Excel)", "Disaster+/**/*.xls*"),
    ("Сводка «10 сола» 2013–2024", "10 сола*.xlsx"),
    ("Карта связи КЧС и ГО (ArcGIS)", "Tajikistan data/*.mxd"),
    ("Карта связи КЧС и ГО (ArcGIS)", "Tajikistan data/1 ПЕЧАТЬ КАРТЫ/*.jpg"),
    ("База ESTJ, 2010 (SQL Server 2005)", "*.bak"),
]
ZIPS = [
    ("Карта связи КЧС и ГО (ArcGIS)", "Tajikistan data/Data.gdb", "Data.gdb.zip"),
    ("Карта связи КЧС и ГО (ArcGIS)", "Tajikistan data/растр", "Рельеф (растр).zip"),
]


def main() -> None:
    if os.path.exists(BUNDLE):
        shutil.rmtree(BUNDLE)
    os.makedirs(BUNDLE + "data")
    os.makedirs(BUNDLE + "gis")
    payload = {"incident_types": types(), "incidents": incidents(), "damage": damage(), "stats": stats()}
    for name, rows in payload.items():
        with open(f"{BUNDLE}data/{name}.json", "w", encoding="utf-8") as out:
            json.dump(rows, out, ensure_ascii=False)
    layers = []
    for key, title, visible, layer_style in LAYERS:
        shutil.copy(f"{OUT}gis/{key}.gpkg", f"{BUNDLE}gis/{key}.gpkg")
        layers.append({"key": key, "file": f"gis/{key}.gpkg", "layer": key, "name": title,
                       "visible": visible, "style": layer_style})
    archive = []
    for folder, pattern in ARCHIVE:
        for path in sorted(glob.glob("/data/" + pattern, recursive=True)):
            if os.path.basename(path).startswith("."):
                continue
            rel = f"archive/{folder}/{os.path.relpath(path, '/data').replace('/', ' — ')}"
            os.makedirs(os.path.dirname(BUNDLE + rel), exist_ok=True)
            shutil.copy(path, BUNDLE + rel)
            archive.append({"folder": folder, "file": rel, "name": os.path.basename(path)})
    for folder, src, name in ZIPS:
        rel = f"archive/{folder}/{name}"
        os.makedirs(os.path.dirname(BUNDLE + rel), exist_ok=True)
        with zipfile.ZipFile(BUNDLE + rel, "w", zipfile.ZIP_DEFLATED) as z:
            for root, _, files in os.walk("/data/" + src):
                for fname in files:
                    if fname.startswith("."):
                        continue
                    full = os.path.join(root, fname)
                    z.write(full, os.path.relpath(full, "/data/" + os.path.dirname(src)))
        archive.append({"folder": folder, "file": rel, "name": name})
    manifest = {
        "version": 1,
        "title": "История ЧС Таджикистана 1988–2026",
        "data": {k: f"data/{k}.json" for k in payload},
        "counts": {k: len(v) for k, v in payload.items()},
        "layers": layers,
        "map": {"name": "Карта связи КЧС и ГО", "camera": {"center": [71.2, 38.7], "zoom": 6.3}},
        "archive": archive,
        "archiveRoot": "Архив данных КЧС 1988–2026",
    }
    with open(BUNDLE + "manifest.json", "w", encoding="utf-8") as out:
        json.dump(manifest, out, ensure_ascii=False, indent=2)
    size = sum(os.path.getsize(os.path.join(r, x)) for r, _, fs in os.walk(BUNDLE) for x in fs)
    print("пакет:", manifest["counts"], "слоёв", len(layers), "файлов архива", len(archive), f"{size / 1e6:.0f} МБ")


if __name__ == "__main__":
    main()
