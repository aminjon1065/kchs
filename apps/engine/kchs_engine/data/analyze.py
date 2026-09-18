"""Анализ файла импорта (06-analytics-engine.md §2 п. 2, ADR-0046).

По голове файла — формат, кодировка, разделитель, листы, строки над
заголовком и заголовок, типы и семантика столбцов, ключи полей, геометрия,
предпросмотр и предупреждения. Ответ — `ImportAnalysis` контракта
(`packages/contracts/src/data/import.ts`) в camelCase.
"""

import asyncio
import math
import re
import tempfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from kchs_engine.contracts import data_import_contract
from kchs_engine.data.geometry import GEOJSON_GEOMETRY_TYPES, GeometryError, any_to_ewkt
from kchs_engine.data.keys import unique_keys
from kchs_engine.data.profile import Profile, build_profile, sample_rows
from kchs_engine.data.readers import (
    EXCEL_FORMATS,
    MAX_JSON_BYTES,
    SAMPLE_BYTES,
    BrokenLine,
    ImportFileError,
    JsonSource,
    Opened,
    TextSampleSource,
    detect_format,
    open_head,
)
from kchs_engine.data.values import (
    EMAIL,
    TEXT_LIMITS,
    URL,
    cell_text,
    is_blank,
    is_null_token,
    looks_like_phone,
    parse_boolean,
    parse_date,
    parse_integer,
    parse_json_text,
    parse_number,
    parse_time,
)
from kchs_engine.storage import download, object_size, read_range

# Доля значений выборки, достаточная для типа (остальное — `invalid`)
TYPE_SHARE = 0.9
# Длина ячейки в предпросмотре и примерах
CELL_PREVIEW_CHARS = 200

TYPE_NAMES = {
    "text": "текст",
    "long_text": "длинный текст",
    "integer": "целое число",
    "number": "число",
    "decimal": "десятичное число",
    "money": "деньги",
    "percent": "процент",
    "boolean": "да/нет",
    "date": "дата",
    "datetime": "дата и время",
    "time": "время",
    "select": "список",
    "identifier": "идентификатор",
    "url": "ссылка",
    "email": "эл. почта",
    "phone": "телефон",
    "json": "JSON",
    "geometry": "геометрия",
}


def _limits() -> dict[str, Any]:
    limits: dict[str, Any] = data_import_contract()["limits"]
    return limits


def plural(count: int, one: str, few: str, many: str) -> str:
    """Русское согласование с числом: 1 значение, 2 значения, 5 значений."""
    tail = count % 100
    if 11 <= tail <= 14:
        return many
    if count % 10 == 1:
        return one
    if 2 <= count % 10 <= 4:
        return few
    return many


def _short(text: str) -> str:
    return text if len(text) <= CELL_PREVIEW_CHARS else text[: CELL_PREVIEW_CHARS - 1] + "…"


def _preview_cell(cells: list[Any], index: int) -> str | None:
    """Ячейка предпросмотра — текст как в файле (пустая — null)."""
    if index >= len(cells):
        return None
    text = cell_text(cells[index])
    return _short(text) if text is not None else None


# ─── Подсказки по названию столбца ───────────────────────────────────────────

_NOT_TOKEN = re.compile(r"[^0-9a-zа-яёғӣқӯҳҷ]+")
_ID_HINT = re.compile(
    r" (id|код|code|номер|no|nr|инн|inn|uuid|guid|key|ключ|артикул|шифр|идентификатор\w*|"
    r"рақам\w*|рамз\w*) "
)
_PHONE_HINT = re.compile(
    r" (телефон\w*|тел|phone|mobile|моб\w*|сотов\w*|факс|fax|whatsapp|telegram) "
)
_DATE_HINT = re.compile(r" (дат\w*|date\w*|день|day|срок\w*|период\w*|period|сана\w*|dt) ")
_TIME_HINT = re.compile(r" (врем\w*|time\w*|вақт\w*) ")
_YEAR_HINT = re.compile(r" (год|года|year|сол|соли) ")
_BOOL_HINT = re.compile(
    r" (признак\w*|флаг\w*|flag|is|has|актив\w*|active|наличие|enabled|да нет) "
)
_LAT_HINT = re.compile(r" (lat|latitude|широта|arz|арз|y) |широт")
_LON_HINT = re.compile(r" (lon|lng|long|longitude|долгота|x) |долгот")


@dataclass(frozen=True)
class _Hints:
    identifier: bool
    phone: bool
    date: bool
    time: bool
    year: bool
    boolean: bool
    lat: bool
    lon: bool


def _hints(name: str) -> _Hints:
    text = " " + _NOT_TOKEN.sub(" ", name.lower().replace("ё", "е")).strip() + " "
    return _Hints(
        identifier="№" in name or bool(_ID_HINT.search(text)),
        phone=bool(_PHONE_HINT.search(text)),
        date=bool(_DATE_HINT.search(text)),
        time=bool(_TIME_HINT.search(text)),
        year=bool(_YEAR_HINT.search(text)),
        boolean=bool(_BOOL_HINT.search(text)),
        lat=bool(_LAT_HINT.search(text)),
        lon=bool(_LON_HINT.search(text)),
    )


# ─── Типы значений ───────────────────────────────────────────────────────────

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_CODE = re.compile(r"[\w./\-#№]+")
# Серийные числа дат Excel, похожие на даты: 1954…2119 год
_SERIAL_MIN, _SERIAL_MAX = 20_000, 80_000


def _number_value(raw: Any, text: str, decimal: str) -> float | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int | float):
        value = float(raw)
        return value if math.isfinite(value) else None
    if not isinstance(raw, str):
        return None
    parsed = parse_number(text, decimal)
    if parsed is None:
        return None
    try:
        value = float(parsed.text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _fraction_digits(raw: Any, text: str, decimal: str) -> int:
    if isinstance(raw, float):
        digits = repr(raw)
        if "e" in digits or "E" in digits:
            return 0
        return len(digits.split(".", 1)[1].rstrip("0")) if "." in digits else 0
    if isinstance(raw, str):
        parsed = parse_number(text, decimal)
        if parsed and "." in parsed.text and "e" not in parsed.text.lower():
            return len(parsed.text.split(".", 1)[1])
    return 0


def _is_geometry(raw: Any, text: str) -> bool:
    if isinstance(raw, dict):
        if raw.get("type") not in GEOJSON_GEOMETRY_TYPES:
            return False
    elif not isinstance(raw, str):
        return False
    try:
        any_to_ewkt(raw)
    except (GeometryError, ValueError, TypeError, RecursionError):
        return False
    return True


def _looks_geometry(raw: Any, text: str) -> bool:
    """Похоже на геометрию, даже если записано с ошибкой (для подсчёта invalid)."""
    if isinstance(raw, dict):
        return raw.get("type") in GEOJSON_GEOMETRY_TYPES
    upper = text.lstrip().upper()
    return upper.startswith(
        ("POINT", "LINESTRING", "POLYGON", "MULTI", "GEOMETRYCOLLECTION", "SRID=")
    ) or (text.lstrip().startswith("{") and '"coordinates"' in text)


def _is_boolean(raw: Any, text: str) -> bool:
    if isinstance(raw, bool):
        return True
    if isinstance(raw, int | float):
        return raw in (0, 1)
    return isinstance(raw, str) and parse_boolean(text) is not None


def _is_zero_one(raw: Any, text: str) -> bool:
    if isinstance(raw, bool):
        return False
    if isinstance(raw, int | float):
        return raw in (0, 1)
    return text in ("0", "1")


def _is_integer(raw: Any, text: str, decimal: str) -> bool:
    if isinstance(raw, bool):
        return False
    if isinstance(raw, int):
        return -(2**63) <= raw < 2**63
    if isinstance(raw, float):
        return raw.is_integer() and abs(raw) < 2**63
    return isinstance(raw, str) and parse_integer(text, decimal) is not None


@dataclass
class _Dates:
    valid: int = 0
    with_time: int = 0
    patterns: Counter[str] = field(default_factory=Counter)


def _scan_dates(present: list[tuple[Any, str]], order: str) -> _Dates:
    result = _Dates()
    for raw, text in present:
        if isinstance(raw, datetime):
            result.valid += 1
            if raw.time() != time(0):
                result.with_time += 1
        elif isinstance(raw, date):
            result.valid += 1
        elif isinstance(raw, str):
            parsed = parse_date(text, order)
            if parsed is None:
                continue
            result.valid += 1
            result.patterns[parsed.pattern] += 1
            if parsed.has_time and parsed.value.time() != time(0):
                result.with_time += 1
    return result


def _is_time(raw: Any, text: str) -> bool:
    if isinstance(raw, time):
        return True
    if isinstance(raw, timedelta):
        return timedelta(0) <= raw < timedelta(days=1)
    return isinstance(raw, str) and parse_time(text) is not None


# ─── Столбец ─────────────────────────────────────────────────────────────────


@dataclass
class ColumnInfo:
    index: int
    name: str
    header: str
    type: str
    semantic: str
    format: dict[str, Any] | None
    empty_share: float
    unique: bool
    invalid: int
    samples: list[str]
    present: int
    notes: list[str]
    hints: _Hints
    numbers: list[float] = field(default_factory=list)
    geometry_kind: str | None = None

    def payload(self, key: str) -> dict[str, Any]:
        data: dict[str, Any] = {
            "index": self.index,
            "name": self.name,
            "key": key,
            "type": self.type,
            "semantic": self.semantic,
            "emptyShare": round(self.empty_share, 4),
            "unique": self.unique,
            "invalid": self.invalid,
            "samples": self.samples,
        }
        if self.format:
            data["format"] = self.format
        return data


def infer_column(index: int, header: str, values: list[Any], profile: Profile) -> ColumnInfo:
    """Тип, семантика и формат столбца по значениям выборки."""
    name = header or f"Столбец {index + 1}"
    hints = _hints(header)
    decimal = profile.decimal
    present: list[tuple[Any, str]] = []
    empty = 0
    for raw in values:
        text = cell_text(raw)
        if text is None or (isinstance(raw, str) and is_null_token(text)):
            empty += 1
        else:
            present.append((raw, text))
    total = len(values)
    count = len(present)
    texts = [text for _raw, text in present]
    distinct = len(set(texts))
    samples: list[str] = []
    for text in texts:
        short = _short(text)
        if short not in samples:
            samples.append(short)
            if len(samples) >= int(_limits()["samplesPerColumn"]):
                break
    unique = count >= 2 and empty == 0 and distinct == count
    info = ColumnInfo(
        index=index,
        name=name,
        header=header,
        type="text",
        semantic="dimension",
        format=None,
        empty_share=empty / total if total else 0.0,
        unique=unique,
        invalid=0,
        samples=samples,
        present=count,
        notes=[],
        hints=hints,
    )
    if count == 0:
        return info

    def enough(valid: int) -> bool:
        return valid >= math.ceil(TYPE_SHARE * count)

    def settle(
        kind: str, semantic: str, valid: int, fmt: dict[str, Any] | None = None
    ) -> ColumnInfo:
        info.type, info.semantic, info.format = kind, semantic, fmt
        info.invalid = count - valid
        return info

    # Геометрия: WKT/EWKT или GeoJSON-объект геометрии
    geometry_valid = sum(1 for raw, text in present if _is_geometry(raw, text))
    if enough(geometry_valid) or (
        geometry_valid and enough(sum(1 for raw, text in present if _looks_geometry(raw, text)))
    ):
        first = next(raw for raw, _text in present)
        info.geometry_kind = (
            "geojson" if isinstance(first, dict) or str(first).lstrip().startswith("{") else "wkt"
        )
        return settle("geometry", "geometry", geometry_valid)

    # Да/нет; столбец только из 0 и 1 — число, если название не подсказывает иное
    boolean_valid = sum(1 for raw, text in present if _is_boolean(raw, text))
    if enough(boolean_valid):
        zero_one = all(_is_zero_one(raw, text) for raw, text in present)
        if not zero_one or hints.boolean:
            return settle("boolean", "category", boolean_valid)

    dates = _scan_dates(present, profile.date_order)
    if enough(dates.valid):
        kind = "datetime" if dates.with_time else "date"
        fmt: dict[str, Any] | None = None
        if dates.patterns:
            pattern = dates.patterns.most_common(1)[0][0]
            if kind == "datetime" and "HH" not in pattern:
                pattern += " HH:mm"
            fmt = {"dateFormat": pattern}
            if len(dates.patterns) > 1:
                shown = ", ".join(_pattern_label(item) for item in dates.patterns)
                info.notes.append(
                    f"Столбец «{name}»: даты записаны в разных форматах ({shown}) — "
                    "при загрузке приводятся к одному"
                )
        return settle(kind, "time", dates.valid, fmt)

    time_valid = sum(1 for raw, text in present if _is_time(raw, text))
    if enough(time_valid):
        return settle("time", "dimension", time_valid)

    parsed_numbers = [_number_value(raw, text, decimal) for raw, text in present]
    numeric = [value for value in parsed_numbers if value is not None]
    info.numbers = numeric

    integer_valid = sum(1 for raw, text in present if _is_integer(raw, text, decimal))
    if enough(integer_valid):
        digit_texts = [text for raw, text in present if isinstance(raw, str) and text.isdigit()]
        if (hints.date or hints.time) and _serial_dates(numeric):
            info.notes.append(f"Столбец «{name}»: числа распознаны как даты Excel")
            return settle("date", "time", integer_valid)
        if any(len(text) > 1 and text.startswith("0") for text in digit_texts):
            # Коды с ведущими нулями (почтовый индекс, код района): число их потеряет
            return settle("identifier", "identifier" if unique else "category", integer_valid)
        if hints.phone and all(looks_like_phone(text) for _raw, text in present):
            return settle("phone", "identifier" if unique else "dimension", integer_valid)
        longest = max((len(text.lstrip("-")) for text in texts), default=0)
        if longest >= 12 or (hints.identifier and longest >= 9):
            # Длинные номера (ИНН, счёт, телефон без «+») — идентификаторы, а не величины
            return settle("identifier", "identifier" if unique else "category", integer_valid)
        if hints.identifier:
            # «№», «Код района»: номер строки — идентификатор, повторяющийся код — категория
            return settle("integer", "identifier" if unique else "category", integer_valid)
        if hints.year and numeric and all(1800 <= value <= 2200 for value in numeric):
            return settle("integer", "dimension", integer_valid)
        if hints.lat or hints.lon:
            return settle("integer", "dimension", integer_valid)
        return settle("integer", "measure", integer_valid, _thousands_format(present, profile))

    number_valid = len(numeric)
    if enough(number_valid):
        if (hints.date or hints.time) and _serial_dates(numeric):
            info.notes.append(f"Столбец «{name}»: числа распознаны как даты и время Excel")
            return settle("datetime", "time", number_valid)
        precision = max(_fraction_digits(raw, text, decimal) for raw, text in present)
        number_format: dict[str, Any] = {}
        if precision:
            number_format["precision"] = min(precision, 12)
        number_format.update(_thousands_format(present, profile) or {})
        percent = sum(1 for raw, text in present if isinstance(raw, str) and text.endswith("%"))
        if enough(percent):
            number_format["scale"] = "percent"
            return settle("percent", "measure", number_valid, number_format)
        semantic = "dimension" if hints.lat or hints.lon else "measure"
        return settle("number", semantic, number_valid, number_format or None)

    json_valid = sum(
        1
        for raw, text in present
        if isinstance(raw, dict | list) or (isinstance(raw, str) and parse_json_text(text))
    )
    if enough(json_valid):
        return settle("json", "dimension", json_valid)

    if enough(sum(1 for _raw, text in present if EMAIL.fullmatch(text))):
        valid = sum(1 for _raw, text in present if EMAIL.fullmatch(text))
        return settle("email", "identifier" if unique else "dimension", valid)
    if enough(sum(1 for _raw, text in present if URL.fullmatch(text))):
        valid = sum(1 for _raw, text in present if URL.fullmatch(text))
        return settle("url", "identifier" if unique else "dimension", valid)
    phones = sum(1 for _raw, text in present if looks_like_phone(text))
    if enough(phones) and (
        hints.phone or any(char in text for _raw, text in present for char in "+()- ")
    ):
        return settle("phone", "identifier" if unique else "dimension", phones)

    uuids = sum(1 for _raw, text in present if _UUID.fullmatch(text))
    codes = sum(1 for _raw, text in present if len(text) <= 64 and _CODE.fullmatch(text))
    if enough(uuids) or (hints.identifier and enough(codes) and distinct >= 0.9 * count):
        valid = uuids if enough(uuids) else codes
        return settle("identifier", "identifier" if unique else "category", valid)

    longest = max(len(text) for text in texts)
    multiline = sum(1 for text in texts if "\n" in text)
    if longest > 1000 or multiline >= max(1, 0.05 * count):
        too_long = sum(1 for text in texts if len(text) > TEXT_LIMITS["long_text"])
        return settle("long_text", "text", count - too_long)
    too_long = sum(1 for text in texts if len(text) > TEXT_LIMITS["text"])
    average = sum(len(text) for text in texts) / count
    if average > 60:
        semantic = "text"
    elif count >= 10 and distinct <= 50 and distinct <= count / 2:
        semantic = "category"
    elif hints.identifier and unique:
        semantic = "identifier"
    else:
        semantic = "dimension"
    return settle("text", semantic, count - too_long)


def _serial_dates(numbers: list[float]) -> bool:
    return bool(numbers) and all(_SERIAL_MIN <= value <= _SERIAL_MAX for value in numbers)


def _thousands_format(present: list[tuple[Any, str]], profile: Profile) -> dict[str, Any] | None:
    """Разделитель тысяч в записи чисел столбца — формат отображения с разрядами."""
    separator = profile.thousands
    if not separator:
        return None
    marks = {separator} | ({" ", "\u00a0", "\u202f"} if separator == " " else set())
    grouped = any(
        isinstance(raw, str) and any(mark in text for mark in marks) for raw, text in present
    )
    return {"thousands": True} if grouped else None


_PATTERN_LABELS = {"d": "д", "M": "м", "y": "г", "H": "ч", "m": "м"}


def _pattern_label(pattern: str) -> str:
    """«dd.MM.yyyy» → «дд.мм.гггг» — формат даты так, как его пишут по-русски."""
    if "MMMM" in pattern:
        return "день месяц год"
    return "".join(_PATTERN_LABELS.get(char, char) for char in pattern)


# ─── Геометрия ───────────────────────────────────────────────────────────────


def _within(column: ColumnInfo, limit: float) -> bool:
    """Значения столбца — координаты: не меньше 90 % в пределах ±limit."""
    values = column.numbers
    if not values:
        return False
    inside = sum(1 for value in values if -limit <= value <= limit)
    return inside >= math.ceil(TYPE_SHARE * len(values))


def _suggest_geometry(opened: Opened, columns: list[ColumnInfo]) -> dict[str, Any] | None:
    if opened.format == "geojson":
        return {"kind": "features"}
    for column in columns:
        if column.type == "geometry" and column.geometry_kind:
            return {"kind": column.geometry_kind, "column": column.index}
    numeric = [column for column in columns if column.type in ("integer", "number")]
    lat = next((c for c in numeric if c.hints.lat and _within(c, 90)), None)
    lon = next((c for c in numeric if c.hints.lon and c is not lat and _within(c, 180)), None)
    if lat is not None and lon is not None:
        return {"kind": "latlon", "lat": lat.index, "lon": lon.index}
    return None


def _features_note(profile: Profile, opened: Opened) -> str | None:
    """Геометрии объектов GeoJSON, которые не загрузятся."""
    source = opened.source
    if not isinstance(source, JsonSource) or source.geometry_index is None:
        return None
    position = source.geometry_index
    invalid = 0
    for _number, cells in profile.data:
        geometry = cells[position] if position < len(cells) else None
        if geometry is None:
            continue
        try:
            any_to_ewkt(geometry)
        except (GeometryError, ValueError, TypeError, RecursionError):
            invalid += 1
    if not invalid:
        return None
    return (
        f"Геометрия {invalid} {plural(invalid, 'объекта', 'объектов', 'объектов')} выборки "
        "не читается (незамкнутые кольца, координаты вне диапазона) — "
        "такие строки попадут в файл ошибок"
    )


# ─── Оценка числа строк ──────────────────────────────────────────────────────


def _data_rows(profile: Profile) -> int:
    return sum(
        1
        for number, cells in profile.records
        if number > profile.start and any(not is_blank(cell) for cell in cells)
    )


def _row_estimate(opened: Opened, profile: Profile, file_size: int) -> tuple[int, bool]:
    """Число строк данных: точное, если голова — весь файл, иначе пропорционально размеру."""
    source = opened.source
    if opened.format in EXCEL_FORMATS:
        if profile.exhausted:
            return _data_rows(profile), False
        sheet_rows = dict(opened.sheets).get(opened.sheet or "", 0)
        return max(sheet_rows - profile.start, _data_rows(profile)), True
    if profile.exhausted and opened.whole:
        return _data_rows(profile), False
    if isinstance(source, TextSampleSource):
        counted = source.count_rows(profile.start)
        if opened.whole:
            return counted, False
        return round(counted * file_size / max(opened.head_bytes, 1)), True
    if isinstance(source, JsonSource):
        if opened.whole:
            rows = sum(
                1 for _number, cells in source.rows() if any(not is_blank(cell) for cell in cells)
            )
            return rows, False
        counted, share = source.count_rows()
        covered = max(opened.head_bytes * share, 1.0)
        return round(counted * file_size / covered), True
    return _data_rows(profile), not opened.whole  # pragma: no cover


# ─── Анализ ──────────────────────────────────────────────────────────────────


def analyze_file(
    path: Path,
    file_name: str,
    options: dict[str, Any],
    *,
    complete: bool,
    file_size: int | None = None,
) -> dict[str, Any]:
    """`ImportAnalysis` по файлу (`complete`) или его началу."""
    size = file_size if file_size is not None else path.stat().st_size
    opened = open_head(path, file_name, options, complete=complete, discover=sample_rows())
    try:
        if opened.format in ("json", "geojson") and size > MAX_JSON_BYTES:
            raise ImportFileError(
                "too_large",
                "JSON больше 256 МБ читается только целиком — сохраните данные в NDJSON или CSV",
            )
        return _analysis(opened, options, size)
    finally:
        opened.source.close()


def _analysis(opened: Opened, options: dict[str, Any], size: int) -> dict[str, Any]:
    profile = build_profile(opened, options)
    warnings: list[str] = list(opened.warnings)
    if profile.width == 0:
        raise ImportFileError("empty", "в файле нет данных")
    if opened.encoding == "cp1252" and not options.get("encoding"):
        warnings.append(
            "Кодировку файла определить не удалось — использована Windows-1252; "
            "если текст выглядит неверно, укажите кодировку вручную"
        )
    warnings.extend(profile.notes)

    columns: list[ColumnInfo] = []
    skipped: list[int] = []
    for index in range(profile.width):
        values = [cells[index] if index < len(cells) else None for _number, cells in profile.data]
        header = profile.names[index] if index < len(profile.names) else ""
        info = infer_column(index, header, values, profile)
        if not header and info.present == 0 and opened.format not in ("json", "ndjson", "geojson"):
            skipped.append(index + 1)
            continue
        columns.append(info)

    keys = unique_keys([column.header for column in columns], [c.index for c in columns])
    duplicates = sorted(
        {name for name, times in Counter(c.name for c in columns).items() if times > 1}
    )
    if duplicates:
        shown = ", ".join(f"«{name}»" for name in duplicates[:5])
        warnings.append(
            f"Повторяющиеся названия столбцов ({shown}) — ключам полей добавлены номера"
        )
    if skipped:
        shown = ", ".join(str(number) for number in skipped[:10])
        warnings.append(f"Пустые столбцы без названия не показаны: {shown}")
    for column in columns:
        warnings.extend(column.notes)
        if column.invalid:
            warnings.append(
                f"Столбец «{column.name}»: {column.invalid} "
                f"{plural(column.invalid, 'значение', 'значения', 'значений')} из "
                f"{column.present} не {plural(column.invalid, 'подходит', 'подходят', 'подходят')} "
                f"к типу «{TYPE_NAMES[column.type]}» — такие строки попадут в файл ошибок"
            )
    broken = [
        number for number, cells in profile.data if cells and isinstance(cells[0], BrokenLine)
    ]
    if broken and opened.format == "ndjson":
        shown = ", ".join(str(number) for number in broken[:5])
        warnings.append(f"Строки не читаются как JSON: {shown} — они попадут в файл ошибок")
    features = _features_note(profile, opened) if opened.format == "geojson" else None
    if features:
        warnings.append(features)

    row_estimate, approx = _row_estimate(opened, profile, size)
    preview_rows = int(_limits()["previewRows"])
    preview = [
        [_preview_cell(cells, index) for index in range(profile.width)]
        for _number, cells in profile.records[:preview_rows]
    ]
    return {
        "format": opened.format,
        "encoding": opened.encoding,
        "delimiter": opened.delimiter,
        "decimal": profile.decimal,
        "thousands": profile.thousands,
        "dateOrder": profile.date_order if profile.text_dates else None,
        "sheets": [{"name": name, "rows": rows} for name, rows in opened.sheets],
        "sheet": opened.sheet,
        "skipRows": profile.skip_rows,
        "headerRows": profile.header_rows,
        "rowEstimate": row_estimate,
        "approx": approx,
        "columns": [column.payload(key) for column, key in zip(columns, keys, strict=True)],
        "preview": preview,
        "geometry": _suggest_geometry(opened, columns),
        "warnings": warnings,
    }


async def analyze_object(
    bucket: str, key: str, file_name: str, options: dict[str, Any]
) -> dict[str, Any]:
    """Анализ файла из хранилища за `analyzeTimeoutMs` (TimeoutError — не уложились)."""
    timeout = float(_limits()["analyzeTimeoutMs"]) / 1000
    return await asyncio.wait_for(_analyze_object(bucket, key, file_name, options), timeout)


async def _analyze_object(
    bucket: str, key: str, file_name: str, options: dict[str, Any]
) -> dict[str, Any]:
    size = await object_size(bucket, key)
    if size > int(_limits()["maxFileBytes"]):
        raise ImportFileError("too_large", "файл больше 2 ГБ")
    if size == 0:
        raise ImportFileError("empty", "файл пуст")
    with tempfile.TemporaryDirectory(prefix="kchs-analyze-", ignore_cleanup_errors=True) as tmp:
        target = Path(tmp) / "source"
        complete = size <= SAMPLE_BYTES
        head = await read_range(bucket, key, min(size, SAMPLE_BYTES))
        fmt = detect_format(head[:65536], file_name, options.get("format"))
        if not complete and fmt in EXCEL_FORMATS:
            # Книгу Excel (zip) по началу не прочитать — нужна целиком
            await download(bucket, key, target)
            complete = True
        else:
            target.write_bytes(head)
        return await asyncio.to_thread(
            analyze_file, target, file_name, options, complete=complete, file_size=size
        )
