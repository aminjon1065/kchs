"""Акты оценки ущерба (Word, 2013–2026) → /out/damage_assessments.csv и события 2021–2026.

Блок акта: заголовок с районом → текст (решение комиссии, дата и вид бедствия, перечень
повреждений) → «Маблағи умумии зарар … сомониро ташкил медиҳад». События 2013–2020 уже есть
в реестре Disaster: акт к ним только привязывается (тот же район, дата ±3 дня); события
2021–2026 берутся из актов — другого источника за эти годы нет.
"""

from __future__ import annotations

import collections
import csv
import datetime as dt
import glob
import re
import sys

import docx

sys.path.insert(0, "/tools")
from common import Gazetteer, clean, classify, flat, load_territories  # noqa: E402

OUT = "/out/"
MONTHS_TG = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "май": 5, "июн": 6, "июл": 7,
             "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}
MONTH_RE = "|".join(MONTHS_TG)

HEADING = re.compile(
    r"^(?:ноҳияи|нохияи|ноҳия|шаҳри|шахри|вилояти|н\.|ш\.)\s*\S.{0,50}$|^(?:ВМКБ|ВМҚБ|НТҶ)\.?$",
    re.IGNORECASE,
)
START = re.compile(r"^(?:Бар\s+асари|Тибқи|Дар\s+натиҷаи|Рӯзи|Рузи|Санаи|Ҳангоми|Шаби|\d{1,3}\.)", re.IGNORECASE)
NUMBERED = re.compile(r"^\d{1,3}\.\s+(?:Санаи|Рӯзи|Рузи|Дар)\b")
TOTAL = re.compile(r"Маблағи\s+умумии\s+зарар(?:и\s+расида)?\s+(?:дар\s+)?(.*?)\s+((?:[\d\s.,]+\s*(?:млн\.?|миллион)\s*)?[\d\s.,]*(?:\s*ҳазор[уи]?\s*[\d\s.,]*)?)\s*(?:сомони|сомонӣ)", re.IGNORECASE)
DECISION = re.compile(r"(?:қарори|амри|фармоиши)\s+[Рр]аиси\s+[^№]{0,80}?аз\s+(\d{1,2})\s+(" + MONTH_RE + r")\w*\s+(?:соли\s+)?(\d{4})[^№]{0,15}№\s*(\d+)", re.IGNORECASE)
EVENT_DAY = re.compile(r"(?:рӯз(?:и|ҳои)|рӯзи|рузи|рузҳои|шаби|санаи)\s+(\d{1,2})(?:\s*(?:[-–,]|ва)\s*(\d{1,2})(?:-?ӯм\w*)?)*\s+(" + MONTH_RE + r")\w*\s+(?:соли\s+)?(\d{4})?", re.IGNORECASE)
EVENT_DOTTED = re.compile(r"(?:Санаи|санаҳои|рӯзи|рузи|рӯзҳои|рузҳои)\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?", re.IGNORECASE)
EVENT_MONTH = re.compile(r"(?:моҳ(?:и|ҳои|хои)|мохи|моххои)\s+(" + MONTH_RE + r")", re.IGNORECASE)
CAUSE = re.compile(r"(?:бар\s+асари|дар\s+натиҷаи|бо\s+сабаби|бинобар)\s+(.{5,140}?)(?:\s+рӯз|\s+рӯзҳои|\s+рузи|\s+моҳи|\s+дар\s+|,|$)", re.IGNORECASE)
DEATHS = re.compile(r"(\d+)\s+нафар\s+(?:\S+\s+){0,6}?(?:ба\s+ҳалокат|ҳалок|фавт|вафот|ҷон\s+бохт)", re.IGNORECASE)

ITEMS = {
    "houses": re.compile(r"(\d+)\s+(?:адад\s+)?(?:хона|манзил)", re.I),
    "houses_full": re.compile(r"(\d+)\s+(?:адад\s+)?(?:хона\w*\s+)?(?:\S+\s+){0,2}(?:бо\s+пуррагӣ|пурра)", re.I),
    "schools": re.compile(r"(\d+)\s+адад\s+(?:\S+\s+){0,1}(?:мактаб|муассиса\w*\s+томактабӣ|боғча)", re.I),
    "medical": re.compile(r"(\d+)\s+адад\s+(?:\S+\s+){0,1}(?:дармонгоҳ|беморхона|ташхисгоҳ|нуқтаи\s+тиббӣ)", re.I),
    "bridges": re.compile(r"(\d+)\s+адад\s+(?:\S+\s+){0,1}(?:кӯпрук|купрук)", re.I),
    "roads_km": re.compile(r"([\d.,]+)\s*км\s+(?:\S+\s+){0,1}роҳ", re.I),
    "power_km": re.compile(r"([\d.,]+)\s*км\s+(?:\S+\s+){0,2}(?:интиқоли\s+барқ|барқ)", re.I),
    "canals_km": re.compile(r"([\d.,]+)\s*км\s+(?:\S+\s+){0,2}(?:шабака\w*\s+обёр|канал|ҷӯй|обёрӣ|обёри)", re.I),
    "livestock": re.compile(r"(\d+)\s+сар\s+(?:\S+\s+){0,1}(?:ҳайвон|чорво)", re.I),
}


def amount(text: str) -> float | None:
    """«84,1 ҳазор» → 84100; «1 млн 154 ҳазору 200» → 1154200; «44,590.4 ҳазор» → 44590400."""
    t = clean(text).lower().replace(" ", " ")
    total = 0.0
    m = re.search(r"([\d.,\s]+?)\s*(?:млн\.?|миллион)", t)
    if m:
        total += num(m.group(1)) * 1_000_000
        t = t[m.end():]
    m = re.search(r"([\d.,\s]+?)\s*ҳазор[уи]?", t)
    if m:
        total += num(m.group(1)) * 1000
        t = t[m.end():]
    rest = re.search(r"([\d][\d\s.,]*)", t)
    if rest and total:
        total += num(rest.group(1))
    elif rest and not total:
        total = num(rest.group(1))
    return round(total, 2) if total else None


TOTAL_STRONG = re.compile(r"маблағи\s*умуми[иӣ]?\s*(?:и\s*)?зарар", re.IGNORECASE)
TOTAL_WEAK = re.compile(r"маблағи\s*зарари\s*расида", re.IGNORECASE)


def total_of(text: str) -> tuple[str, float, str] | None:
    """Итог акта: последняя фраза «маблағи умумии зарар …» (иначе «маблағи зарари расида …»)
    до слова «сомонӣ» → (фраза, сумма в сомони, место из фразы)."""
    found = list(TOTAL_STRONG.finditer(text)) or list(TOTAL_WEAK.finditer(text))
    for match in reversed(found):
        tail = text[match.end():match.end() + 260]
        end = re.search(r"сомон", tail, re.IGNORECASE)
        if not end:
            continue
        phrase = tail[:end.start()]
        digits = re.search(r"\d", phrase)
        if not digits:
            continue
        value = amount(re.sub(r"\([^)]*\)", " ", phrase[digits.start():]))
        if value:
            place = re.sub(r"^\s*(?:дар|ба)\s+", "", phrase[:digits.start()]).strip(" ,.")
            return clean(text[match.start():match.end() + end.end()]), value, place
    return None


def num(text: str) -> float:
    s = text.strip().replace(" ", "")
    if "," in s and "." in s:  # «44,590.4» — запятая тысяч
        s = s.replace(",", "")
    s = s.replace(",", ".")
    s = re.sub(r"\.(?=.*\.)", "", s)  # лишние точки
    try:
        return float(s)
    except ValueError:
        return 0.0


def first_int(pattern: re.Pattern, text: str, mode: str = "sum") -> float | None:
    values = [num(m.group(1)) for m in pattern.finditer(text)]
    if not values:
        return None
    return round(sum(values), 2) if mode == "sum" else values[0]


def event_date(text: str, doc_year: int) -> tuple[dt.date | None, str, str]:
    m = EVENT_DOTTED.search(text)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3) or doc_year)
        try:
            return dt.date(y, mo, d), "day", m.group(0)
        except ValueError:
            pass
    for m in EVENT_DAY.finditer(text):
        before = text[max(0, m.start() - 25):m.start()].lower()
        if "қарор" in before or " аз " in before[-5:]:
            continue  # дата решения, а не бедствия
        mo = next(v for k, v in MONTHS_TG.items() if m.group(3).lower().startswith(k))
        y = int(m.group(4)) if m.group(4) else doc_year
        try:
            return dt.date(y, mo, int(m.group(1))), "day", m.group(0)
        except ValueError:
            continue
    m = EVENT_MONTH.search(text)
    if m:
        mo = next(v for k, v in MONTHS_TG.items() if m.group(1).lower().startswith(k))
        return dt.date(doc_year, mo, 1), "month", m.group(0)
    return None, "year", ""


def blocks_of(path: str) -> list[tuple[str, list[str]]]:
    d = docx.Document(path)
    blocks: list[tuple[str, list[str]]] = []
    title, body = "", []
    closed = False
    for p in d.paragraphs:
        text = clean(p.text)
        if not text:
            continue
        bold = any(r.bold for r in p.runs if r.text.strip())
        is_total = text.lower().startswith("маблағи умумии")
        heading = not is_total and len(text) <= 60 and (HEADING.match(text) or (bold and len(text) <= 40))
        numbered = bool(NUMBERED.match(text))
        if heading or numbered:
            if body:
                blocks.append((title, body))
            title, body = (text if heading else ""), ([] if heading else [text])
            closed = False
            continue
        body.append(text)
        if is_total:
            if len(body) == 1 and blocks and blocks[-1][0] == title and not any(
                b.lower().startswith("маблағи умумии") for b in blocks[-1][1]
            ):
                blocks[-1][1].append(text)  # итог отдельной строкой — к своему акту
            else:
                blocks.append((title, body))
            title, body = title, []
            closed = True
            continue
        if closed and not START.match(text) and blocks and len(body) == 1:
            blocks[-1][1].append(body.pop())  # продолжение после итога — к тому же акту
            continue
        closed = False
    if body:
        blocks.append((title, body))
    return blocks


def main() -> None:
    territories = load_territories()
    gaz = Gazetteer(territories)
    disaster = list(csv.DictReader(open(OUT + "incidents_disaster.csv", encoding="utf-8")))
    index = collections.defaultdict(list)
    for r in disaster:
        index[r["territory"]].append(r)

    records, incidents = [], []
    per_year = collections.Counter()
    for path in sorted(glob.glob("/data/ЧС/*.docx")):
        doc_year = int(re.search(r"(\d{4})", path).group(1))
        for title, body in blocks_of(path):
            text = "\n".join(body)
            if len(text) < 40:
                continue
            totals = total_of(text)
            # Район: заголовок блока, иначе «дар ноҳияи X» в тексте
            place_text = title.strip(" .:") or (totals[2] if totals else "")
            if not place_text:
                m = re.search(r"(?:ноҳияи|шаҳри)\s+([А-ЯЁҲҚҒҶӮӢ][\w.\-]+(?:\s+[А-ЯЁҲҚҒҶӮӢ][\w.\-]+)?)", text)
                place_text = m.group(0) if m else ""
            place = gaz.place("", place_text, doc_year)
            if place.level in ("region", "country"):
                for m in re.finditer(r"(?:ноҳияи|нохияи)\s+([А-ЯЁҲҚҒҶӮӢа-яёҳқғҷӯӣ.\-]+(?:\s+[А-ЯЁҲҚҒҶӮӢ][\w.\-]+)?)", text):
                    inner = gaz.place("", m.group(0), doc_year)
                    if inner.level == "district" and (territories[inner.code].parent == place.code or place.code == "TJ"):
                        place = inner
                        break
            date, precision, date_text = event_date(text, doc_year)
            if date is None:
                # Дата бедствия не названа: месяц первого документа комиссии
                doc = re.search(r"\bаз\s+(\d{1,2})\s+(" + MONTH_RE + r")\w*\s+(?:соли\s+)?(\d{4})", text, re.IGNORECASE)
                if doc:
                    mo = next(v for k, v in MONTHS_TG.items() if doc.group(2).lower().startswith(k))
                    date, precision, date_text = dt.date(int(doc.group(3)), mo, 1), "month", f"по документу комиссии: {doc.group(0)}"
            cause = CAUSE.search(text)
            cause_text = clean(cause.group(1)) if cause else ""
            type_code, how = classify(cause_text, text)
            decision = DECISION.search(text)
            dec_date = ""
            if decision:
                mo = next(v for k, v in MONTHS_TG.items() if decision.group(2).lower().startswith(k))
                try:
                    dec_date = dt.date(int(decision.group(3)), mo, int(decision.group(1))).isoformat()
                except ValueError:
                    dec_date = ""
            total = totals[1] if totals else None
            deaths = sum(int(m.group(1)) for m in DEATHS.finditer(text)) or None
            item = {k: first_int(p, text, "first" if k.startswith("houses") else "sum") for k, p in ITEMS.items()}
            year = (date.year if date else doc_year)
            per_year[doc_year] += 1
            code = f"D{doc_year}-{per_year[doc_year]:03d}"

            # Привязка к событию реестра Disaster (до 2020): тот же район, дата ±3 дня
            linked = ""
            if date and year <= 2020 and place.code:
                for r in index.get(place.code, []):
                    when = dt.date.fromisoformat(r["occurred_at"][:10])
                    if abs((when - date).days) <= 3:
                        linked = r["code"]
                        break
            incident_code = linked
            if year >= 2021 or (not linked and year > 2020):
                incident_code = f"H{year}-{code}"  # номер акта уникален, год события — для порядка
                occurred = dt.datetime(year, date.month if date else 1, date.day if date else 1)
                incidents.append({
                    "code": incident_code,
                    "occurred_at": occurred.strftime("%Y-%m-%dT00:00:00+05:00"),
                    "date_precision": precision if date else "year",
                    "date_text": date_text,
                    "type_code": type_code,
                    "type_raw": cause_text,
                    "territory": place.code or "TJ",
                    "territory_note": place.note,
                    "region_raw": "",
                    "district_raw": place_text,
                    "occurrences": 1,
                    "place": "",
                    "description": text,
                    "deaths": deaths or "",
                    "deaths_from_text": "true" if deaths else "",
                    "injured": "", "rescued": "", "bodies_recovered": "", "rescue_team": "",
                    "affected_text": "",
                    "damage": total or "",
                    "damage_raw": totals[0] if totals else "",
                    "needs_raw": "", "info_source": "Акт оценки ущерба", "legacy_code": "",
                    "origin": f"ЧС/{path.split('/')[-1]}, блок «{place_text or '—'}»",
                })
            records.append({
                "code": code,
                "incident_code": incident_code,
                "event_date": date.isoformat() if date else "",
                "date_precision": precision if date else "year",
                "year": year,
                "type_code": type_code,
                "cause": cause_text,
                "territory": place.code or "TJ",
                "territory_note": place.note,
                "place_raw": place_text,
                "decision_date": dec_date,
                "decision_no": decision.group(4) if decision else "",
                "houses": item["houses"] or "", "houses_destroyed": item["houses_full"] or "",
                "schools": item["schools"] or "", "medical": item["medical"] or "",
                "bridges": item["bridges"] or "", "roads_km": item["roads_km"] or "",
                "power_km": item["power_km"] or "", "canals_km": item["canals_km"] or "",
                "livestock": item["livestock"] or "",
                "deaths": deaths or "",
                "damage": total or "",
                "damage_text": totals[0] if totals else "",
                "text": text,
                "origin": f"ЧС/{path.split('/')[-1]}",
            })

    with open(OUT + "damage_assessments.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(records[0]))
        w.writeheader()
        w.writerows(records)
    with open(OUT + "incidents_damage.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(incidents[0]))
        w.writeheader()
        w.writerows(incidents)
    by_year = collections.Counter(r["year"] for r in records)
    print("актов:", len(records), dict(sorted(by_year.items())))
    print("без итоговой суммы:", sum(1 for r in records if not r["damage"]),
          "без даты:", sum(1 for r in records if not r["event_date"]),
          "без района:", sum(1 for r in records if r["territory"] == "TJ"),
          "привязано к Disaster:", sum(1 for r in records if r["incident_code"].startswith("H") and "-D" not in r["incident_code"]))
    print("событий 2021–2026 из актов:", len(incidents), collections.Counter(r["type_code"] for r in incidents).most_common(12))
    print("ущерб по годам, тыс. сомони:", {y: round(sum(float(r["damage"] or 0) for r in records if r["year"] == y) / 1000, 1) for y in sorted(by_year)})


if __name__ == "__main__":
    main()
