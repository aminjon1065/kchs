"""Нормализация файла импорта (ADR-0046): задание `imports:dataset.normalize`.

Весь файл читается потоком, значения приводятся к типам сопоставления по
`NORMALIZED_VALUE_FORMATS` контракта. Результат — два CSV в UTF-8:

- нормализованный (без заголовка): номер строки файла, затем столбцы в порядке
  сопоставления, геометрия — последней; пустое без кавычек — NULL, пустая
  строка текста — `""`. Воркер загружает его `COPY … FROM STDIN (FORMAT csv)`
  в staging-таблицу (`_row` и столбцы полей);
- ошибок (заголовок `row,field,value,code`): номер строки как в файле, ключ
  поля, значение как в файле, код из `IMPORT_ERROR_CODES`.

Строка с ошибкой хотя бы в одном поле в нормализованный файл не попадает.
"""

import csv
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, tzinfo
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from kchs_engine.contracts import data_import_contract
from kchs_engine.data.crs import GeometryReader
from kchs_engine.data.geometry import BadGeometry, GeometryError, ReadyGeometry
from kchs_engine.data.profile import build_profile, sample_rows
from kchs_engine.data.readers import (
    JSON_FORMATS,
    BrokenLine,
    ImportFileError,
    Source,
    open_full,
    open_head,
)
from kchs_engine.data.values import (
    FALSE_TOKENS,
    NULL_TOKENS,
    STRIP_CHARS,
    TEXT_LIMITS,
    TRUE_TOKENS,
    cell_text,
    clean_text,
    dump_json,
    excel_serial_date,
    format_datetime,
    format_float,
    load_json,
    parse_date,
    parse_integer,
    parse_number,
    parse_time,
    resolve_zone,
)

ERROR_SAMPLE_LIMIT = 50
# Значение в файле ошибок и в errorSample — не длиннее (символов)
ERROR_VALUE_CHARS = 500
# Как часто сообщать о ходе (строк)
PROGRESS_EVERY = 5_000

_INT64_MIN, _INT64_MAX = -(2**63), 2**63 - 1
# Серийные числа дат Excel в тексте: не раньше 1927 года (меньшие числа — не даты)
_TEXT_SERIAL_MIN = 10_000
# Целых разрядов: money — numeric(18, 2), decimal — numeric(38, precision)
_MONEY_DIGITS = 16
_NUMERIC_DIGITS = 38


class ImportSpecError(ValueError):
    """Сопоставление или геометрия не подходят к импорту: повтор задания не поможет."""


class CellError(Exception):
    """Значение ячейки не приводится к типу поля; `code` — из IMPORT_ERROR_CODES.

    `raw` — значение для файла ошибок, если оно не одна ячейка (геометрия из
    широты и долготы).
    """

    def __init__(self, code: str, raw: Any = None) -> None:
        super().__init__(code)
        self.code = code
        self.raw = raw


@dataclass(frozen=True)
class MappingItem:
    """Элемент сопоставления `ImportMappingItem` (нужные нормализации поля)."""

    column: int
    field_key: str
    type: str
    required: bool
    format: dict[str, Any]

    @classmethod
    def parse(cls, raw: dict[str, Any]) -> "MappingItem":
        try:
            kind = str(raw["type"])
            column = int(raw["column"])
            field_key = str(raw["fieldKey"])
        except (KeyError, TypeError, ValueError) as error:
            raise ImportSpecError(f"в сопоставлении нет поля {error}") from error
        if kind not in data_import_contract()["fieldTypes"]:
            raise ImportSpecError(f"тип поля «{kind}» импорт не загружает")
        if column < 0:
            raise ImportSpecError(f"неверный номер столбца {column}")
        fmt = raw.get("format") or {}
        return cls(
            column=column,
            field_key=field_key,
            type=kind,
            required=bool(raw.get("required", False)),
            format=dict(fmt) if isinstance(fmt, dict) else {},
        )


@dataclass(frozen=True)
class Context:
    decimal: str
    date_order: str
    zone: tzinfo
    # "" в JSON — пустая строка; в CSV и Excel пустая ячейка — NULL
    keep_empty: bool
    # Справочник территорий: ключ сопоставления → идентификатор, "" — неоднозначно (ADR-0057)
    territories: Mapping[str, str] | None = None
    # Система координат геометрии в столбцах, указанная пользователем (ADR-0068)
    crs: str | None = None


Converter = Callable[[Any], str | None]


@dataclass
class NormalizeResult:
    format: str = ""
    skip_rows: int = 0
    header_rows: int = 0
    # Строк данных в файле (без пустых) и сколько из них с ошибками
    rows: int = 0
    errors: int = 0
    # Строк нормализованного файла и файла ошибок (без заголовка)
    written: int = 0
    error_lines: int = 0
    error_sample: list[dict[str, Any]] = field(default_factory=list)


# ─── Значения ────────────────────────────────────────────────────────────────


def _is_null(text: str) -> bool:
    return text.lower() in NULL_TOKENS


def _text_converter(limit: int, keep_empty: bool) -> Converter:
    empty = "" if keep_empty else None

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return empty
            if not text.isprintable():
                text = clean_text(text)
        else:
            native = cell_text(raw)
            if native is None:
                return None
            text = clean_text(native)
        if len(text) > limit:
            raise CellError("too_long")
        return text

    return convert


def territory_key(text: str) -> str:
    """Ключ сопоставления территории — как `normalizeName` API: регистр, «ё», пробелы."""
    return " ".join(text.lower().replace("ё", "е").split())


def _territory_converter(context: Context) -> Converter:
    """Код, название на любом языке или идентификатор → идентификатор территории."""
    table = context.territories
    if table is None:
        raise ImportSpecError("для поля-территории не передан справочник территорий")
    as_text = _text_converter(TEXT_LIMITS["text"], keep_empty=False)

    def convert(raw: Any) -> str | None:
        text = as_text(raw)
        if text is None or _is_null(text):
            return None
        found = table.get(territory_key(text))
        if found is None:
            raise CellError("unknown_territory")
        if not found:
            raise CellError("ambiguous_territory")
        return found

    return convert


def _integer_converter(context: Context) -> Converter:
    decimal = context.decimal

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        kind = raw.__class__
        if kind is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return None
            if text.isascii() and text.isdigit() and len(text) <= 18:
                return text.lstrip("0") or "0"
            result = parse_integer(text, decimal)
            if result is not None:
                return result
            if _is_null(text):
                return None
            raise CellError("invalid_integer")
        if kind is int:
            if _INT64_MIN <= raw <= _INT64_MAX:
                return str(raw)
        elif kind is float and raw.is_integer() and abs(raw) < 2**63:
            return str(int(raw))
        raise CellError("invalid_integer")

    return convert


def _double_fits(text: str) -> bool:
    """Postgres double precision: не бесконечность и не потеря значения в ноль."""
    try:
        value = float(text)
    except ValueError:
        return False
    if not math.isfinite(value):
        return False
    if value == 0.0:
        mantissa = text.lower().split("e", 1)[0]
        return not any(char in "123456789" for char in mantissa)
    return True


def _numeric_fits(text: str, digits: int) -> bool:
    """Целых разрядов не больше `digits` (numeric(p, s) иначе переполнится)."""
    try:
        value = Decimal(text)
    except InvalidOperation:
        return False
    if not value.is_finite():
        return False
    return value == 0 or value.adjusted() + 1 <= digits


def _number_check(item: MappingItem) -> Callable[[str], bool]:
    if item.type == "money":
        return lambda text: _numeric_fits(text, _MONEY_DIGITS)
    if item.type == "decimal":
        precision = item.format.get("precision")
        scale = min(int(precision), 12) if isinstance(precision, int) else 0
        # numeric без точности хранит до 131072 целых разрядов
        digits = _NUMERIC_DIGITS - scale if isinstance(precision, int) else 131_072
        return lambda text: _numeric_fits(text, digits)
    return _double_fits


def _number_text(raw: Any, decimal: str) -> tuple[str, bool] | None:
    """Каноническая запись числа и признак «%»; None — не число."""
    kind = raw.__class__
    if kind is str:
        parsed = parse_number(raw, decimal)
        return (parsed.text, parsed.percent) if parsed is not None else None
    if kind is int:
        return str(raw), False
    if kind is float:
        return (repr(raw), False) if math.isfinite(raw) else None
    return None


# Частый случай «-12,5» / «12.5» без разделителей тысяч — без полного разбора
_SIMPLE_NUMBER = re.compile(r"-?[0-9]{1,15}(?:([.,])[0-9]{1,15})?")


def _number_converter(item: MappingItem, context: Context) -> Converter:
    decimal = context.decimal
    fits = _number_check(item)
    to_fraction = item.type == "percent" and item.format.get("scale") == "fraction"

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return None
            simple = _SIMPLE_NUMBER.fullmatch(text)
            if simple is not None:
                separator = simple.group(1)
                if separator is None or (separator == decimal == "."):
                    return text
                if separator == decimal:
                    return text.replace(",", ".")
            parsed = _number_text(text, decimal)
            if parsed is None:
                if _is_null(text):
                    return None
                raise CellError("invalid_number")
        else:
            parsed = _number_text(raw, decimal)
            if parsed is None:
                raise CellError("invalid_number")
        value, has_percent = parsed
        if to_fraction and has_percent:
            value = format(Decimal(value).scaleb(-2).normalize(), "f")
        if (len(value) > 15 or "e" in value or "E" in value) and not fits(value):
            raise CellError("invalid_number")
        return value

    return convert


def _boolean_converter() -> Converter:
    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        kind = raw.__class__
        if kind is str:
            token = raw.strip(STRIP_CHARS).lower()
            if token in TRUE_TOKENS:
                return "true"
            if token in FALSE_TOKENS:
                return "false"
            if token in NULL_TOKENS:
                return None
            raise CellError("invalid_boolean")
        if kind is bool:
            return "true" if raw else "false"
        if kind in (int, float) and raw in (0, 1):
            return "true" if raw == 1 else "false"
        raise CellError("invalid_boolean")

    return convert


def _column_order(item: MappingItem, context: Context) -> str:
    """Порядок частей даты: из формата поля (dd.MM.yyyy), иначе — файла."""
    pattern = item.format.get("dateFormat")
    if isinstance(pattern, str) and "d" in pattern and "M" in pattern:
        if pattern.lstrip().startswith("y"):
            return "ymd"
        return "dmy" if pattern.index("d") < pattern.index("M") else "mdy"
    return context.date_order


def _fast_date(text: str, order: str) -> str | None:
    """Частые записи даты без регулярных выражений: 2026-09-18 и 18.09.2026."""
    if len(text) != 10:
        return None
    try:
        if text[4] == "-" and text[7] == "-":
            return date.fromisoformat(text).isoformat()
        separator = text[2]
        if separator in "./-" and text[5] == separator:
            first, second, year = int(text[:2]), int(text[3:5]), int(text[6:])
            # Значение само говорит о порядке (день > 12), иначе — порядок столбца
            if second > 12 >= first or (order == "mdy" and not first > 12 >= second):
                day, month = second, first
            else:
                day, month = first, second
            return date(year, month, day).isoformat()
    except ValueError:
        return None
    return None


def _serial(raw: Any, text_minimum: bool) -> datetime | None:
    """Серийное число даты Excel (из числа ячейки или текста «45123»)."""
    if raw.__class__ is str:
        try:
            value = float(raw.replace(",", "."))
        except ValueError:
            return None
        if text_minimum and value < _TEXT_SERIAL_MIN:
            return None
    elif raw.__class__ in (int, float):
        value = float(raw)
    else:
        return None
    if not math.isfinite(value):
        return None
    return excel_serial_date(value)


def _date_converter(item: MappingItem, context: Context) -> Converter:
    order = _column_order(item, context)

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return None
            fast = _fast_date(text, order)
            if fast is not None:
                return fast
            parsed = parse_date(text, order)
            if parsed is not None:
                return parsed.value.date().isoformat()
            serial = _serial(text, True)
            if serial is not None:
                return serial.date().isoformat()
            if _is_null(text):
                return None
            raise CellError("invalid_date")
        if isinstance(raw, datetime):
            return raw.date().isoformat()
        if isinstance(raw, date):
            return raw.isoformat()
        serial = _serial(raw, False)
        if serial is not None:
            return serial.date().isoformat()
        raise CellError("invalid_date")

    return convert


def _datetime_converter(item: MappingItem, context: Context) -> Converter:
    order = _column_order(item, context)
    zone = context.zone

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return None
            parsed = parse_date(text, order)
            if parsed is not None:
                return format_datetime(parsed.value, parsed.offset, zone)
            serial = _serial(text, True)
            if serial is not None:
                return format_datetime(serial, None, zone)
            if _is_null(text):
                return None
            raise CellError("invalid_datetime")
        if isinstance(raw, datetime):
            if raw.tzinfo is not None:
                return raw.isoformat(timespec="microseconds" if raw.microsecond else "seconds")
            return format_datetime(raw, None, zone)
        if isinstance(raw, date):
            return format_datetime(datetime(raw.year, raw.month, raw.day), None, zone)
        serial = _serial(raw, False)
        if serial is not None:
            return format_datetime(serial, None, zone)
        raise CellError("invalid_datetime")

    return convert


def _time_converter(context: Context) -> Converter:
    order = context.date_order

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text:
                return None
            parsed_time = parse_time(text)
            if parsed_time is not None:
                return parsed_time.isoformat()
            parsed = parse_date(text, order)
            if parsed is not None and parsed.has_time:
                return parsed.value.time().replace(microsecond=0).isoformat()
            if _is_null(text):
                return None
            raise CellError("invalid_time")
        if isinstance(raw, datetime):
            return raw.time().replace(microsecond=0).isoformat()
        if isinstance(raw, time):
            return raw.replace(microsecond=0, tzinfo=None).isoformat()
        if isinstance(raw, timedelta) and timedelta(0) <= raw < timedelta(days=1):
            return (datetime.min + raw).time().replace(microsecond=0).isoformat()
        if raw.__class__ is float and 0 <= raw < 1:
            # Время в Excel — доля суток
            seconds = min(round(raw * 86_400), 86_399)
            return (datetime.min + timedelta(seconds=seconds)).time().isoformat()
        raise CellError("invalid_time")

    return convert


def _json_converter(limit: int) -> Converter:
    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        if raw.__class__ is str:
            text = raw.strip(STRIP_CHARS)
            if not text or _is_null(text):
                return None
            try:
                result = dump_json(load_json(text))
            except (ValueError, RecursionError) as error:
                raise CellError("invalid_json") from error
        elif isinstance(raw, dict | list | int | float | bool):
            try:
                result = dump_json(raw)
            except (ValueError, RecursionError) as error:
                raise CellError("invalid_json") from error
        else:
            raise CellError("invalid_json")
        if len(result) > limit:
            raise CellError("too_long")
        return result

    return convert


def _geometry_converter(reader: GeometryReader) -> Converter:
    """Ячейка геометрии → EWKT в EPSG:4326 (с пересчётом из системы координат файла)."""

    def convert(raw: Any) -> str | None:
        if raw is None:
            return None
        kind = raw.__class__
        if kind is ReadyGeometry:
            # Геометрия объекта геоформата: уже пересчитана и проверена при чтении
            return str(raw)
        if kind is BadGeometry:
            raise CellError("invalid_geometry", raw.text)
        if kind is str:
            text = raw.strip(STRIP_CHARS)
            if not text or _is_null(text):
                return None
            source: Any = text
        elif isinstance(raw, dict):
            source = raw
        else:
            raise CellError("invalid_geometry", raw)
        try:
            return reader.value(source)
        except (GeometryError, ImportFileError, ValueError, TypeError, RecursionError) as error:
            raise CellError("invalid_geometry", raw) from error

    return convert


def converter(item: MappingItem, context: Context) -> Converter:
    """Функция приведения значения ячейки к типу поля."""
    kind = item.type
    if kind in ("integer",):
        return _integer_converter(context)
    if kind in ("number", "decimal", "money", "percent"):
        return _number_converter(item, context)
    if kind == "boolean":
        return _boolean_converter()
    if kind == "date":
        return _date_converter(item, context)
    if kind == "datetime":
        return _datetime_converter(item, context)
    if kind == "time":
        return _time_converter(context)
    if kind == "json":
        return _json_converter(TEXT_LIMITS["json"])
    if kind == "geometry":
        return _geometry_converter(GeometryReader(context.crs))
    if kind == "territory":
        return _territory_converter(context)
    return _text_converter(TEXT_LIMITS.get(kind, TEXT_LIMITS["text"]), context.keep_empty)


# ─── Геометрия из столбцов ───────────────────────────────────────────────────

GeometryBuilder = Callable[[list[Any]], str | None]


def _coordinate(raw: Any, decimal: str) -> str | None:
    parsed = _number_text(raw, decimal) if raw.__class__ in (str, int, float) else None
    if parsed is None or parsed[1]:
        return None
    return parsed[0] if raw.__class__ is not float else format_float(raw)


def _cell(cells: list[Any], index: int) -> Any:
    return cells[index] if 0 <= index < len(cells) else None


def _blank(raw: Any) -> bool:
    if raw is None:
        return True
    if raw.__class__ is str:
        text = raw.strip(STRIP_CHARS)
        return not text or _is_null(text)
    return False


def geometry_builder(
    spec: dict[str, Any],
    context: Context,
    source: Source,
    reader: GeometryReader | None = None,
) -> GeometryBuilder:
    """Геометрия строки по `ImportGeometry`: широта/долгота, WKT, GeoJSON, объект.

    Система координат — указанная пользователем, иначе объявленная в GeoJSON,
    иначе WGS 84; геометрии геоформатов источник уже пересчитал сам.
    """
    kind = spec.get("kind")
    decimal = context.decimal
    if reader is None:
        reader = GeometryReader(context.crs or getattr(source, "declared_crs", None))
    geometry_value = _geometry_converter(reader)
    try:
        if kind == "latlon":
            lat_index, lon_index = int(spec["lat"]), int(spec["lon"])
        elif kind in ("wkt", "geojson"):
            column = int(spec["column"])
    except (KeyError, TypeError, ValueError) as error:
        raise ImportSpecError(f"в описании геометрии «{kind}» нет номера столбца") from error
    if kind == "latlon":

        def from_pair(cells: list[Any]) -> str | None:
            lat, lon = _cell(cells, lat_index), _cell(cells, lon_index)
            lat_blank, lon_blank = _blank(lat), _blank(lon)
            if lat_blank and lon_blank:
                return None
            shown = f"{cell_text(lat) or ''}; {cell_text(lon) or ''}"
            if lat_blank or lon_blank:
                raise CellError("invalid_geometry", shown)
            lat_text, lon_text = _coordinate(lat, decimal), _coordinate(lon, decimal)
            if lat_text is None or lon_text is None:
                raise CellError("invalid_geometry", shown)
            try:
                return reader.point(lon_text, lat_text)
            except (GeometryError, ImportFileError, ValueError) as error:
                raise CellError("invalid_geometry", shown) from error

        return from_pair
    if kind in ("wkt", "geojson"):
        return lambda cells: geometry_value(_cell(cells, column))
    if kind == "features":
        position = source.geometry_index
        if position is None:
            return lambda _cells: None
        return lambda cells: geometry_value(_cell(cells, position))
    raise ImportSpecError(f"неизвестный вид геометрии «{kind}»")


# ─── Файл ────────────────────────────────────────────────────────────────────


def _error_text(raw: Any) -> str | None:
    """Значение ячейки для файла ошибок — как в файле, не длиннее ERROR_VALUE_CHARS."""
    if raw is None:
        return None
    text = raw.strip(STRIP_CHARS) if raw.__class__ is str else cell_text(raw)
    if not text:
        return None
    if len(text) > ERROR_VALUE_CHARS:
        text = text[: ERROR_VALUE_CHARS - 1] + "…"
    return text


_PLAIN_NUMBER = re.compile(r"[-+]?[0-9][0-9 .,]*")


def _spreadsheet_safe(text: str | None) -> str:
    """Файл ошибок открывают в Excel: значение «=…», «-2+…» не должно стать формулой."""
    if not text:
        return ""
    if text[0] in "=+-@\t\r" and not _PLAIN_NUMBER.fullmatch(text):
        return "'" + text
    return text


def normalize_file(
    path: Path,
    file_name: str,
    options: dict[str, Any],
    mapping: list[dict[str, Any]],
    geometry: dict[str, Any] | None,
    geometry_field: str | None,
    normalized_path: Path,
    errors_path: Path,
    *,
    zone: str | None = None,
    progress: Callable[[float, int], None] | None = None,
    territories: Mapping[str, str] | None = None,
) -> NormalizeResult:
    """Весь файл → нормализованный CSV и CSV ошибок. ImportFileError — файл не читается."""
    items = [MappingItem.parse(item) for item in mapping]
    head = open_head(path, file_name, options, complete=True, discover=sample_rows())
    try:
        profile = build_profile(head, options)
        source = open_full(path, head)
        context = Context(
            decimal=profile.decimal,
            date_order=profile.date_order,
            zone=resolve_zone(zone),
            keep_empty=head.format in JSON_FORMATS,
            territories=territories,
            crs=options.get("crs"),
        )
        converters = [
            (item.column, converter(item, context), item.field_key, item.required) for item in items
        ]
        # Геометрия — отдельное поле датасета: столбец пишется, если поле задано
        build_geometry = (
            geometry_builder(geometry, context, source) if geometry and geometry_field else None
        )
        result = NormalizeResult(
            format=head.format, skip_rows=profile.skip_rows, header_rows=profile.header_rows
        )
        _process(
            source,
            profile.start,
            converters,
            build_geometry,
            geometry_field or "geometry",
            normalized_path,
            errors_path,
            result,
            progress,
        )
        return result
    finally:
        head.source.close()


def _process(
    source: Source,
    start: int,
    converters: list[tuple[int, Converter, str, bool]],
    build_geometry: GeometryBuilder | None,
    geometry_key: str,
    normalized_path: Path,
    errors_path: Path,
    result: NormalizeResult,
    progress: Callable[[float, int], None] | None,
) -> None:
    sample = result.error_sample

    def record(number: int, key: str, raw: Any, code: str) -> None:
        value = _error_text(raw)
        errors_writer.writerow([number, key, _spreadsheet_safe(value), code])
        result.error_lines += 1
        if len(sample) < ERROR_SAMPLE_LIMIT:
            sample.append({"row": number, "column": key, "value": value, "reason": code})

    with (
        normalized_path.open("w", encoding="utf-8", errors="replace", newline="") as normalized,
        errors_path.open("w", encoding="utf-8", errors="replace", newline="") as errors_file,
    ):
        # NULL — пустое поле без кавычек, всё остальное (и пустая строка) — в кавычках
        writer = csv.writer(normalized, quoting=csv.QUOTE_NOTNULL, lineterminator="\n")
        errors_writer = csv.writer(errors_file, lineterminator="\n")
        errors_writer.writerow(["row", "field", "value", "code"])
        rows = 0
        for number, cells in source.rows():
            if number <= start:
                continue
            for cell in cells:
                if cell is None:
                    continue
                if cell.__class__ is str and (not cell or cell.isspace()):
                    continue
                break
            else:
                # Пустая строка — не строка данных
                continue
            rows += 1
            if progress is not None and rows % PROGRESS_EVERY == 0:
                progress(source.progress(), rows)
            if cells and cells[0].__class__ is BrokenLine:
                record(number, "", cells[0], "invalid_json")
                result.errors += 1
                continue
            values: list[Any] = [number]
            failed = False
            for column, convert, key, required in converters:
                raw = cells[column] if column < len(cells) else None
                try:
                    value = convert(raw)
                except CellError as error:
                    record(number, key, raw, error.code)
                    failed = True
                    continue
                if value is None and required:
                    record(number, key, raw, "required")
                    failed = True
                    continue
                values.append(value)
            if build_geometry is not None:
                try:
                    values.append(build_geometry(cells))
                except CellError as error:
                    record(number, geometry_key, error.raw, error.code)
                    failed = True
            if failed:
                result.errors += 1
                continue
            writer.writerow(values)
            result.written += 1
        result.rows = rows
        if progress is not None:
            progress(1.0, rows)
