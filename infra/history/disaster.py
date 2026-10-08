"""Реестр Disaster (Excel, 1988–2020) → /out/incidents_disaster.csv и сверка.

Каждая строка — событие в схеме реестра «Происшествия» пакета ЧС плюс поля истории:
точность даты, вид и место как в источнике, спасённые, ущерб как в источнике, откуда строка.
"""

from __future__ import annotations

import collections
import csv
import datetime as dt
import re
import sys

import openpyxl
import xlrd

sys.path.insert(0, "/tools")
from common import Gazetteer, clean, classify, flat, integer, load_territories, number  # noqa: E402

SRC = "/data/Disaster+/"
OUT = "/out/"

MONTHS = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "май": 5, "мая": 5, "июн": 6, "июл": 7,
          "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12,
          "уюн": 6, "уюл": 7, "сентабр": 9}


def sheet_xlsx(name: str, sheet: str) -> list[list]:
    ws = openpyxl.load_workbook(SRC + name, read_only=True, data_only=True)[sheet]
    return [list(r) for r in ws.iter_rows(values_only=True)]


def sheet_xls(name: str, sheet: str) -> list[list]:
    sh = xlrd.open_workbook(SRC + name).sheet_by_name(sheet)
    return [sh.row_values(r) for r in range(sh.nrows)]


def col(head: list, *needles: str, exclude: str | None = None) -> int | None:
    """Номер колонки по словам заголовка (первое совпадение)."""
    for i, cell in enumerate(head):
        text = clean(cell).lower()
        if any(n.lower() in text for n in needles) and not (exclude and exclude.lower() in text):
            return i
    return None


def month_of(value: object) -> int | None:
    n = integer(value)
    if n and 1 <= n <= 12:
        return n
    text = clean(value).lower()
    for prefix, m in MONTHS.items():
        if text.startswith(prefix):
            return m
    return None


def day_of(value: object) -> tuple[int | None, str]:
    """День: «12», «12.0», «25-26», «3,4» → (первый день, текст как в источнике)."""
    text = clean(value)
    if isinstance(value, float) and value == int(value):
        text = str(int(value))
    match = re.match(r"^\s*(\d{1,2})", text)
    day = int(match.group(1)) if match else None
    return (day if day and 1 <= day <= 31 else None), text


TIME = re.compile(r"(?:соат[иу]?|в|соати)\s*(\d{1,2})[:.,](\d{2})|(\d{1,2}):(\d{2})")


def time_of(description: str) -> tuple[int, int] | None:
    match = TIME.search(description[:200])
    if not match:
        return None
    h, m = (match.group(1), match.group(2)) if match.group(1) else (match.group(3), match.group(4))
    hour, minute = int(h), int(m)
    return (hour, minute) if hour < 24 and minute < 60 else None


DEATHS = [
    re.compile(r"погиб(?:ло|ли|ла|)\s+(\d+)\s*(?:чел|человек|жител|ребен|дет)", re.I),
    re.compile(r"(\d+)\s*(?:чел\.?|человек[а]?|жител[ьяей]+|детей|ребенка?)\s+(?:\S+\s+)?погиб", re.I),
    re.compile(r"(\d+)\s*нафар\s+(?:\S+\s+){0,3}(?:ҳалок|халок|фавт|вафот|ҷон)", re.I),
    re.compile(r"(?:ҳалок|халок|фавт)\s+(?:\S+\s+){0,2}(\d+)\s*нафар", re.I),
]
ONE_DEATH = re.compile(r"погиб(?:ла|)\s+(?:одна\s+|один\s+)?(?:мать|женщин|мужчин|ребен|девоч|мальч|человек|житель|пастух|школьн)", re.I)
INJURED = [
    re.compile(r"(?:ранен[оы]?|травмирован[оы]?|пострадал[ои]?)\s+(\d+)\s*(?:чел|человек)", re.I),
    re.compile(r"(\d+)\s*(?:чел\.?|человек[а]?)\s+(?:\S+\s+)?(?:ранен|травм|пострадал)", re.I),
]


def from_text(patterns: list[re.Pattern], text: str) -> int | None:
    total = 0
    for pattern in patterns:
        for match in pattern.finditer(text):
            total = max(total, int(match.group(1)))
    return total or None


# ── Источники: заголовок, колонки ───────────────────────────────────────────
def read_source(label: str, rows: list[list], header_row: int, fname: str, sheet: str) -> list[dict]:
    head = rows[header_row]
    c = {
        "legacy": col(head, "код"),
        "type": col(head, "DISASTER", "ОФАТХО"),
        "province": col(head, "PROVINCE", "ВИЛОЯТ"),
        "district": col(head, "DISTRICT", "НОХИЯ"),
        "location": col(head, "LOCATION", "ЧАМОАТ"),
        "year": col(head, "YEAR", "СОЛ"),
        "month": col(head, "Month", "МОХ"),
        "day": col(head, "Days", "САНА"),
        "desc": col(head, "TYPE OF DAMAGE", "НАМУДИ ХОДИСА"),
        "affected": col(head, "POPULATION AFFECTED"),
        "deaths": col(head, "фавтида", "халокшуда"),
        "injured": col(head, "Чарохат"),
        "rescued": col(head, "Начотёфта", "начотёфта"),
        "team": col(head, "Баромади", "баромади"),
        "bodies": col(head, "часад"),
        "source": col(head, "SOURCE OF INFO"),
        "damage": col(head, "DAMAGE SUM"),
        "need": col(head, "NEED"),
        "note": col(head, "Эзоҳ"),
    }
    # В 2017 году «POPULATION AFFECTED (ҳалокшудагон)» — это погибшие
    if c["deaths"] is None and c["affected"] is not None and "халок" in clean(head[c["affected"]]).lower():
        c["deaths"], c["affected"] = c["affected"], None
    blank_after_deaths = (c["deaths"] + 1) if c["deaths"] is not None and c["deaths"] + 1 < len(head) and not clean(head[c["deaths"] + 1]) else None
    extra_damage = 15 if label == "1992-2016" else None

    def cell(row: list, key: str):
        i = c[key]
        return row[i] if i is not None and i < len(row) else None

    out: list[dict] = []
    year_default = int(label) if label.isdigit() else None
    for index, row in enumerate(rows[header_row + 1:], start=header_row + 2):
        raw_type = clean(cell(row, "type"))
        desc = clean(cell(row, "desc"))
        district = clean(cell(row, "district"))
        if not (raw_type or desc or district):
            continue
        year = integer(cell(row, "year")) or year_default
        if not year or not (1900 < year < 2100):
            # Год не указан: из описания («… 1998 года»), иначе строка в сверку без года
            found = re.search(r"\b(19[89]\d|20[0-2]\d)\b", desc)
            year = int(found.group(1)) if found else None
            if not year and not (raw_type and desc):
                continue
        out.append({
            "label": label, "file": fname, "sheet": sheet, "row": index,
            "legacy": clean(cell(row, "legacy")),
            "type_raw": raw_type, "province": clean(cell(row, "province")), "district": district,
            "location": clean(cell(row, "location")),
            "year": year, "month": month_of(cell(row, "month")), "day": day_of(cell(row, "day")),
            "desc": desc, "affected": clean(cell(row, "affected")),
            "deaths": integer(cell(row, "deaths")), "injured": integer(cell(row, "injured")),
            "rescued": integer(cell(row, "rescued")), "team": clean(cell(row, "team")),
            "bodies": integer(cell(row, "bodies")),
            "extra_note": clean(row[blank_after_deaths]) if blank_after_deaths is not None and blank_after_deaths < len(row) else "",
            "source": clean(cell(row, "source")), "damage": cell(row, "damage"),
            "damage2": row[extra_damage] if extra_damage is not None and extra_damage < len(row) else None,
            "need": clean(cell(row, "need")), "note": clean(cell(row, "note")),
        })
    return out


def signature(r: dict) -> tuple:
    """Одно и то же событие в разных версиях файла: по началу описания (даты и колонки в
    копиях бывают сдвинуты), без описания — по дате и району."""
    text = flat(r["desc"])
    if len(text) >= 15:
        return ("desc", text[:40])
    return ("place", r["year"], r["month"], r["day"][0], flat(r["district"])[:6])


def main() -> None:
    territories = load_territories()
    gaz = Gazetteer(territories)

    primary = [
        ("1992-2016", sheet_xls("Disaster 1992-2016.xls", "1"), 0, "Disaster 1992-2016.xls", "1"),
        ("2017", sheet_xlsx("Disaster 2017- 2018.xlsx", "2017"), 0, "Disaster 2017- 2018.xlsx", "2017"),
        ("2018", sheet_xlsx("Disaster 2017- 2018.xlsx", "2018"), 1, "Disaster 2017- 2018.xlsx", "2018"),
        ("2019", sheet_xlsx("2019/Disaster 2019 .xlsx", "2019"), 0, "2019/Disaster 2019 .xlsx", "2019"),
        ("2020", sheet_xlsx("Disaster 2020.xls.xlsx", "Лист1"), 0, "Disaster 2020.xls.xlsx", "Лист1"),
    ]
    alternates = [
        ("2017", sheet_xlsx("Копия Disaster 2017- 2018(АвтоматическиВосстановлено).xlsx", "2017"), 0,
         "Копия Disaster 2017- 2018(АвтоматическиВосстановлено).xlsx", "2017"),
        ("2018", sheet_xlsx("Копия Disaster 2017- 2018(АвтоматическиВосстановлено).xlsx", "2018"), 1,
         "Копия Disaster 2017- 2018(АвтоматическиВосстановлено).xlsx", "2018"),
        ("2018", sheet_xlsx("Disaster 2018 .xlsx", "Лист1"), 1, "Disaster 2018 .xlsx", "Лист1"),
        ("2019", sheet_xlsx("Disaster 2019 (АвтоматическиВосстановлено).xlsx", "2019"), 0,
         "Disaster 2019 (АвтоматическиВосстановлено).xlsx", "2019"),
    ]

    records: list[dict] = []
    dedupe_report = []
    seen: dict[str, set] = collections.defaultdict(set)
    for label, rows, hi, fname, sheet in primary:
        items = read_source(label, rows, hi, fname, sheet)
        for r in items:
            seen[label].add(signature(r))
        records += items
        dedupe_report.append((fname, sheet, "основной", len(items), len(items)))
    for label, rows, hi, fname, sheet in alternates:
        items = read_source(label, rows, hi, fname, sheet)
        new = [r for r in items if signature(r) not in seen[label]]
        for r in new:
            seen[label].add(signature(r))
        records += new
        dedupe_report.append((fname, sheet, "копия", len(items), len(new)))

    # Грозы с жертвами 2002–2013 — отдельный лист. Событие того же дня и района из основного
    # листа получает число погибших; новое добавляется
    storms = sheet_xls("Disaster 1992-2016.xls", "Раъду барк  1")
    added_storms = 0
    by_day: dict[tuple, dict] = {}
    for r in records:
        if r["label"] == "1992-2016":
            by_day.setdefault((r["year"], r["month"], r["day"][0], flat(r["district"])[:5]), r)
    for index, row in enumerate(storms[2:], start=3):
        place, village, year, month, day = (clean(v) for v in row[:5])
        if not (integer(year) and place):
            continue
        deaths = integer(row[6]) if len(row) > 6 else None
        key = (integer(year), month_of(month), day_of(day)[0], flat(place)[:5])
        existing = by_day.get(key)
        if existing:
            if deaths and not existing.get("storm_deaths"):
                existing["storm_deaths"] = deaths
            continue
        records.append({"label": "грозы", "file": "Disaster 1992-2016.xls", "sheet": "Раъду барк  1", "row": index,
             "legacy": "", "type_raw": "гроза", "province": "", "district": place, "location": village,
             "year": integer(year), "month": month_of(month), "day": day_of(day), "desc": clean(row[5]),
             "affected": "", "deaths": deaths, "injured": None,
             "rescued": None, "team": "", "bodies": None, "extra_note": "", "source": "",
             "damage": None, "damage2": None, "need": "", "note": ""})
        added_storms += 1
    dedupe_report.append(("Disaster 1992-2016.xls", "Раъду барк  1", "грозы с жертвами", len(storms) - 2, added_storms))

    # ── Нормализация в строки реестра ───────────────────────────────────────
    no_year = [r for r in records if not r["year"]]
    records = [r for r in records if r["year"]]
    with open(OUT + "review_no_year.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["файл", "лист", "строка", "вид", "район", "описание"])
        for r in no_year:
            w.writerow([r["file"], r["sheet"], r["row"], r["type_raw"], r["district"], r["desc"][:300]])
    print("без года (в сверку, не в реестр):", len(no_year))
    out_rows = []
    per_year = collections.Counter()
    type_stats: dict[tuple, int] = collections.Counter()
    place_stats: dict[tuple, int] = collections.Counter()
    for r in sorted(records, key=lambda x: (x["year"] or 0, x["month"] or 0, x["day"][0] or 0, x["file"], x["row"])):
        year = r["year"]
        month = r["month"]
        day, day_text = r["day"]
        if month and day:
            try:
                date = dt.date(year, month, day)
                precision = "day"
            except ValueError:
                date, precision = dt.date(year, month, 1), "month"
        elif month:
            date, precision = dt.date(year, month, 1), "month"
        else:
            date, precision = dt.date(year, 1, 1), "year"
        hm = time_of(r["desc"]) if precision == "day" else None
        occurred = dt.datetime(date.year, date.month, date.day, *(hm or (0, 0)))
        type_code, type_how = classify(r["type_raw"], r["desc"])
        place = gaz.place(r["province"], r["district"], year)
        per_year[year] += 1
        code = f"H{year}-{per_year[year]:04d}"

        deaths, deaths_from_text = r["deaths"], False
        injured = r["injured"]
        if r["label"] in ("1992-2016",):
            text = f"{r['desc']} {r['affected']}"
            deaths = from_text(DEATHS, text) or (1 if ONE_DEATH.search(text) else None)
            deaths_from_text = deaths is not None
            if r.get("storm_deaths") and not deaths:
                deaths, deaths_from_text = r["storm_deaths"], False
            injured = from_text(INJURED, text)

        # Ущерб: с 2001 года — сомони числом; раньше рубли разного масштаба — только как в источнике
        damage_values = [v for v in (r["damage"], r["damage2"]) if clean(v)]
        damage_raw = " / ".join(clean(v) for v in damage_values)
        damage = None
        if year >= 2001:
            for v in (r["damage2"], r["damage"]):
                n = number(v)
                if n is not None and n > 0:
                    damage = n
                    break

        description = r["desc"]
        extras = [x for x in (r["note"], r["extra_note"]) if x]
        if extras:
            description = f"{description}\n\nПримечание: {'; '.join(extras)}" if description else "; ".join(extras)

        # Сколько явлений в строке: «н. Варзоб 6 тарма», «н. Шуғнон 2 то тарма», «зидди жола (32)»
        many = re.search(r"(\d+)\s*(?:-?\s*то\s+)?тарма", r["district"]) or re.search(r"\((\d+)(?:\s*адад)?\)", r["type_raw"])
        occurrences = int(many.group(1)) if many and 0 < int(many.group(1)) < 1000 else 1
        type_stats[(r["type_raw"].lower(), type_code, type_how)] += 1
        place_stats[(r["province"], r["district"], place.code or "", place.note)] += 1
        out_rows.append({
            "code": code,
            "occurred_at": occurred.strftime("%Y-%m-%dT%H:%M:00+05:00"),
            "date_precision": precision,
            "date_text": " ".join(x for x in (str(year), str(month or ""), day_text) if x),
            "type_code": type_code,
            "type_raw": r["type_raw"],
            "territory": place.code or "",
            "territory_note": place.note,
            "region_raw": r["province"],
            "district_raw": r["district"],
            "occurrences": occurrences,
            "place": r["location"],
            "description": description,
            "deaths": "" if deaths is None else deaths,
            "deaths_from_text": "true" if deaths_from_text else "",
            "injured": "" if injured is None else injured,
            "rescued": "" if r["rescued"] is None else r["rescued"],
            "bodies_recovered": "" if r["bodies"] is None else r["bodies"],
            "rescue_team": "true" if integer(r["team"]) else "",
            "affected_text": r["affected"],
            "damage": "" if damage is None else round(damage, 2),
            "damage_raw": damage_raw,
            "needs_raw": r["need"],
            "info_source": r["source"],
            "legacy_code": r["legacy"],
            "origin": f"{r['file']}, лист «{r['sheet']}», строка {r['row']}",
        })

    fields = list(out_rows[0])
    with open(OUT + "incidents_disaster.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)
    with open(OUT + "review_dedupe.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["файл", "лист", "роль", "строк событий", "взято в реестр"])
        w.writerows(dedupe_report)
    with open(OUT + "review_types_disaster.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["вид в источнике", "код", "как определён", "событий"])
        for (raw, code, how), n in sorted(type_stats.items(), key=lambda x: -x[1]):
            w.writerow([raw, code, how, n])
    with open(OUT + "review_places_disaster.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["область в источнике", "район в источнике", "территория", "замечание", "событий"])
        for (prov, dist, code, note), n in sorted(place_stats.items(), key=lambda x: -x[1]):
            w.writerow([prov, dist, code, note, n])

    total = len(out_rows)
    by_level = collections.Counter(territories[r["territory"]].level if r["territory"] else "нет" for r in out_rows)
    noted = sum(1 for r in out_rows if r["territory_note"])
    types = collections.Counter(r["type_code"] for r in out_rows)
    print(f"событий {total}; привязка: {dict(by_level)}; с замечанием {noted}")
    print("по видам:", types.most_common())
    print("точность дат:", collections.Counter(r["date_precision"] for r in out_rows))
    print("погибших всего:", sum(int(r["deaths"] or 0) for r in out_rows), "из текста:", sum(1 for r in out_rows if r["deaths_from_text"]))
    print("дубли:", dedupe_report)


if __name__ == "__main__":
    main()
