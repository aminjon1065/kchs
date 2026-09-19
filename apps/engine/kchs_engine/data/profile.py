"""Разметка таблицы и локаль значений по голове файла (ADR-0046).

Общая часть анализа и нормализации: сколько строк пропустить над заголовком,
сколько строк занимает заголовок, названия столбцов, десятичный знак,
разделитель тысяч и порядок частей даты. Параметры, заданные пользователем,
имеют приоритет; остальное определяется по одним и тем же строкам головы
файла, поэтому анализ и нормализация видят файл одинаково.
"""

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from kchs_engine.contracts import data_import_contract
from kchs_engine.data.readers import RECORD_FORMATS, Opened, Row, Source
from kchs_engine.data.values import (
    cell_text,
    is_blank,
    is_null_token,
    parse_date,
    parse_number,
)

# Строк сверху, среди которых ищется заголовок таблицы
LAYOUT_SCAN = 30
# Строк заголовка, которые распознаются автоматически (больше — только параметром)
MAX_AUTO_HEADER_ROWS = 2


def sample_rows() -> int:
    return int(data_import_contract()["limits"]["analyzeSampleRows"])


def max_columns() -> int:
    return int(data_import_contract()["limits"]["maxColumns"])


def head_records() -> int:
    """Сколько записей головы читается: зона поиска заголовка и выборка данных."""
    return LAYOUT_SCAN + 5 + sample_rows()


@dataclass
class Profile:
    format: str
    skip_rows: int
    header_rows: int
    # Названия столбцов по индексам файла; "" — у столбца нет названия
    names: list[str]
    width: int
    # Непустые строки данных выборки (не больше analyzeSampleRows)
    data: list[Row]
    # Все прочитанные записи головы и признак «голова прочитана до конца»
    records: list[Row]
    exhausted: bool
    decimal: str
    thousands: str
    date_order: str
    # В выборке есть даты текстом (иначе порядок частей даты не важен)
    text_dates: bool
    notes: list[str] = field(default_factory=list)
    truncated_columns: int = 0
    # Система координат геометрии в столбцах, указанная пользователем (ADR-0068)
    crs: str | None = None

    @property
    def start(self) -> int:
        """Строки файла с номером больше этого — данные (для JSON — все)."""
        return self.skip_rows + self.header_rows


def read_records(source: Source, limit: int) -> tuple[list[Row], bool]:
    """Первые `limit` записей источника и признак «записей больше нет»."""
    records: list[Row] = []
    iterator = source.rows()
    try:
        for row in iterator:
            if len(records) >= limit:
                return records, False
            records.append(row)
    finally:
        close = getattr(iterator, "close", None)
        if close is not None:
            close()
    return records, True


# ─── Разметка ────────────────────────────────────────────────────────────────


def _filled(cells: list[Any]) -> int:
    return sum(1 for cell in cells if not is_blank(cell))


def _meaningful(cell: Any) -> bool:
    """Непустая ячейка, не заглушка «—»/«н/д»."""
    if is_blank(cell):
        return False
    return not (isinstance(cell, str) and is_null_token(cell))


def looks_typed(value: Any) -> bool:
    """Ячейка — число или дата (для поиска строки заголовка среди строк данных)."""
    if value is None or isinstance(value, bool):
        return False
    if not isinstance(value, str):
        return True
    text = value.strip()
    if not text or len(text) > 40:
        return False
    return (
        parse_number(text, ",") is not None
        or parse_number(text, ".") is not None
        or parse_date(text) is not None
    )


def _headerish(cell: Any) -> bool:
    """Похоже на название столбца: текст с буквой, не число и не дата."""
    if not isinstance(cell, str):
        return False
    text = cell.strip()
    return bool(text) and any(char.isalpha() for char in text) and not looks_typed(text)


def _table_start(rows: list[list[Any]]) -> int:
    """Первая строка, заполненная хотя бы наполовину от обычной ширины таблицы."""
    counts = [_filled(cells) for cells in rows[:200]]
    body = [count for count in counts if count >= 2]
    scan = counts[:LAYOUT_SCAN]
    if not body:
        # Один столбец: пропускаются только пустые строки сверху
        return next((index for index, count in enumerate(scan) if count > 0), 0)
    frequency = Counter(body)
    width = max(frequency, key=lambda value: (frequency[value], value))
    threshold = max(2, math.ceil(width * 0.5))
    for index, count in enumerate(scan):
        if count >= threshold:
            return index
    return next((index for index, count in enumerate(scan) if count >= 2), 0)


_YEAR = re.compile(r"(19|20|21)\d\d")


def _is_year(cell: Any) -> bool:
    if isinstance(cell, bool):
        return False
    if isinstance(cell, int):
        return 1900 <= cell <= 2199
    if isinstance(cell, float):
        return cell.is_integer() and 1900 <= cell <= 2199
    return isinstance(cell, str) and bool(_YEAR.fullmatch(cell.strip()))


def _years_header(rows: list[list[Any]], index: int) -> bool:
    """Заголовок из годов («Район | 2023 | 2024»): годы над столбцами не-годов."""
    first = rows[index]
    typed = [(j, cell) for j, cell in enumerate(first) if _meaningful(cell) and looks_typed(cell)]
    if len(typed) < 2 or not all(_is_year(cell) for _j, cell in typed):
        return False
    below = rows[index + 1 : index + 21]
    for j, _cell in typed:
        values = [row[j] for row in below if j < len(row) and _meaningful(row[j])]
        if values and not all(_is_year(value) for value in values):
            return True
    return False


def _second_header_row(rows: list[list[Any]], index: int) -> bool:
    """Вторая строка заголовка: текст над столбцами, где в данных числа и даты.

    Типичный случай — объединённая ячейка «Население» над «Мужчины | Женщины»
    или строка единиц измерения под названиями.
    """
    if index + 2 >= len(rows):
        return False
    second = rows[index + 1]
    data = rows[index + 2 : index + 62]
    cells = [(j, cell) for j, cell in enumerate(second) if _meaningful(cell)]
    if not cells or any(looks_typed(cell) for _j, cell in cells):
        return False
    width = max((len(row) for row in data), default=0)
    typed_columns = []
    for j in range(width):
        values = [row[j] for row in data if j < len(row) and _meaningful(row[j])]
        if len(values) >= 2 and sum(1 for value in values if looks_typed(value)) >= 0.8 * len(
            values
        ):
            typed_columns.append(j)
    if not typed_columns:
        return False
    return any(j < len(second) and _headerish(second[j]) for j in typed_columns)


def _header_rows(rows: list[list[Any]], index: int) -> int:
    if index >= len(rows):
        return 0
    first = [cell for cell in rows[index] if _meaningful(cell)]
    if not first:
        return 0
    typed = sum(1 for cell in first if looks_typed(cell))
    if typed / len(first) > 0.5 and not _years_header(rows, index):
        # Первая строка таблицы — уже данные: заголовка нет
        return 0
    if _second_header_row(rows, index):
        return 2
    return 1


def _header_text(cell: Any) -> str | None:
    text = cell_text(cell)
    if text is None:
        return None
    return " ".join(text.split()) or None


def column_names(rows: list[list[Any]], skip: int, header: int, width: int) -> list[str]:
    """Названия столбцов из строк заголовка; объединённые ячейки верхних строк
    (пустые справа от названия над заполненными подзаголовками) продолжаются вправо.
    """
    if header == 0:
        return [""] * width
    header_rows = rows[skip : skip + header]
    fill: list[str | None] = [None] * header
    names: list[str] = []
    for j in range(width):
        cells = [_header_text(row[j]) if j < len(row) else None for row in header_rows]
        leaf = cells[-1]
        parts: list[str] = []
        for level in range(header - 1):
            text = cells[level]
            if text:
                fill[level] = text
            elif leaf and fill[level]:
                text = fill[level]
            else:
                fill[level] = None
            if text and (not parts or parts[-1] != text):
                parts.append(text)
        if leaf and (not parts or parts[-1] != leaf):
            parts.append(leaf)
        names.append(" / ".join(parts))
    return names


def _trimmed_width(cells: list[Any]) -> int:
    for index in range(len(cells) - 1, -1, -1):
        if not is_blank(cells[index]):
            return index + 1
    return 0


# ─── Локаль: десятичный знак, разделитель тысяч, порядок даты ─────────────────

_GROUP_SPACES = " \u00a0\u202f\u2009\u2007'"
_NUMBER_SHAPE = re.compile(r"[-−+(]?\s*(\d[\d.,'\u00a0\u202f\u2009\u2007 ]*?)\s*%?\)?")
_SPACE_GROUPS = re.compile(r"\d{1,3}(?:[ \u00a0\u202f\u2009\u2007']\d{3})+")
_DOT_GROUPS = re.compile(r"\d{1,3}(?:\.\d{3})+")
_COMMA_GROUPS = re.compile(r"\d{1,3}(?:,\d{3})+")


def _space_grouping(integer_part: str) -> str | None:
    """Разделитель тысяч пробелом или апострофом в целой части: «1 234», «1'234»."""
    if _SPACE_GROUPS.fullmatch(integer_part):
        return "'" if "'" in integer_part else " "
    return None


def _separator_vote(text: str) -> tuple[str | None, str | None]:
    """Голос за десятичный знак («,», «.», «?» — неоднозначно) и замеченный разделитель тысяч."""
    match = _NUMBER_SHAPE.fullmatch(text)
    if not match:
        return None, None
    body = match.group(1)
    last_comma, last_dot = body.rfind(","), body.rfind(".")
    if last_comma < 0 and last_dot < 0:
        return None, _space_grouping(body)
    if last_comma >= 0 and last_dot >= 0:
        # Оба знака: последний — десятичный, первый — группы разрядов (1.234,56)
        decimal = "," if last_comma > last_dot else "."
        other = "." if decimal == "," else ","
        whole = body[: body.rfind(decimal)]
        groups = _DOT_GROUPS if other == "." else _COMMA_GROUPS
        if not groups.fullmatch(whole):
            return None, None
        return decimal, other
    separator = "," if last_comma >= 0 else "."
    parts = body.split(separator)
    if len(parts) > 2:
        # Повтор — это группы разрядов: 1.234.567 → десятичный знак — другой
        groups = _DOT_GROUPS if separator == "." else _COMMA_GROUPS
        if groups.fullmatch(body):
            return ("," if separator == "." else "."), separator
        return None, None
    whole, fraction = parts
    grouping = _space_grouping(whole)
    compact_whole = "".join(char for char in whole if char not in _GROUP_SPACES)
    if not compact_whole.isdigit() or not fraction.isdigit():
        return None, None
    if grouping or len(fraction) != 3 or compact_whole == "0" or len(compact_whole) > 3:
        # «1 234,567», «12,5», «0,125», «1234,567» — знак однозначно десятичный
        return separator, grouping
    return "?", None


@dataclass
class _Locale:
    decimal: str
    thousands: str
    date_order: str
    text_dates: bool
    notes: list[str]


def _detect_locale(
    data: list[Row], width: int, options: dict[str, Any], fmt: str, delimiter: str | None
) -> _Locale:
    decimals: Counter[str] = Counter()
    groupings: Counter[str] = Counter()
    evidence: Counter[str] = Counter()
    numeric_dates = 0
    iso_dates = 0
    for _number, cells in data:
        for cell in cells[:width]:
            if not isinstance(cell, str):
                continue
            text = cell.strip()
            if not text or len(text) > 40:
                continue
            parsed = parse_date(text, "dmy")
            if parsed is not None:
                if parsed.pattern.startswith("yyyy"):
                    iso_dates += 1
                elif "MMMM" not in parsed.pattern:
                    numeric_dates += 1
                    if parsed.evidence:
                        evidence[parsed.evidence] += 1
                continue
            decimal, grouping = _separator_vote(text)
            if decimal:
                decimals[decimal] += 1
            if grouping:
                groupings[grouping] += 1

    notes: list[str] = []
    decimal_option = options.get("decimal")
    if decimal_option in (".", ","):
        decimal = decimal_option
    elif decimals[","] != decimals["."]:
        decimal = "," if decimals[","] > decimals["."] else "."
    else:
        decimal = "," if fmt in ("csv", "tsv") and delimiter == ";" else "."
        if decimals["?"]:
            notes.append(
                "Десятичный разделитель по данным не определить (значения вида 1,234): "
                f"выбран «{decimal}» — при необходимости укажите его вручную"
            )

    thousands_option = options.get("thousands")
    if thousands_option is not None:
        thousands = thousands_option
    else:
        candidates = {
            key: count for key, count in groupings.items() if key != decimal and key in " ,.'"
        }
        thousands = max(candidates, key=lambda key: candidates[key]) if candidates else ""

    order_option = options.get("dateOrder")
    if order_option in ("dmy", "mdy", "ymd"):
        date_order = order_option
    elif evidence:
        date_order = "mdy" if evidence["mdy"] > evidence["dmy"] else "dmy"
    elif numeric_dates:
        date_order = "dmy"
        notes.append(
            "Порядок частей даты по данным не определить (все дни не больше 12): "
            "выбран день.месяц.год"
        )
    elif iso_dates:
        date_order = "ymd"
    else:
        date_order = "dmy"
    return _Locale(decimal, thousands, date_order, bool(numeric_dates or iso_dates), notes)


# ─── Профиль ─────────────────────────────────────────────────────────────────


def build_profile(opened: Opened, options: dict[str, Any]) -> Profile:
    """Разметка и локаль по голове файла."""
    records, exhausted = read_records(opened.source, head_records())
    rows = [cells for _number, cells in records]
    notes: list[str] = []
    limit = sample_rows()

    if opened.format in RECORD_FORMATS:
        # Ключи объектов JSON или поля слоя геоформата; геометрия объекта — не столбец
        source = opened.source
        names = [str(name) for name in getattr(source, "columns", [])]
        skip, header = 0, 0
        data_width = max((len(cells) for cells in rows), default=0)
        if source.geometry_index is not None:
            data_width = source.geometry_index
        width = max(len(names), data_width)
        names += [""] * (width - len(names))
    else:
        skip_option = options.get("skipRows")
        header_option = options.get("headerRows")
        skip = min(int(skip_option), len(rows)) if skip_option is not None else _table_start(rows)
        header = int(header_option) if header_option is not None else _header_rows(rows, skip)
        if skip_option is None and skip > 0:
            notes.append(
                f"Строки над таблицей пропущены: {skip} (название отчёта, пояснения, пустые строки)"
            )
        if header_option is None and header == 0:
            notes.append("Строка заголовка не найдена — столбцы названы по номеру")
        if header_option is None and header == MAX_AUTO_HEADER_ROWS:
            notes.append(
                "Заголовок из двух строк: названия объединены через «/» "
                "(например, «Население / Мужчины»)"
            )
        width = max((_trimmed_width(cells) for cells in rows[skip:]), default=0)
        names = column_names(rows, skip, header, width)

    truncated = 0
    if width > max_columns():
        truncated = width - max_columns()
        notes.append(f"В файле {width} столбцов — загружаются только первые {max_columns()}")
        width = max_columns()
        names = names[:width]

    start = skip + header
    data: list[Row] = []
    for number, cells in records[start:]:
        if len(data) >= limit:
            break
        if any(not is_blank(cell) for cell in cells):
            data.append((number, cells))

    locale = _detect_locale(data, width, options, opened.format, opened.delimiter)
    notes.extend(locale.notes)
    return Profile(
        format=opened.format,
        skip_rows=skip,
        header_rows=header,
        names=names,
        width=width,
        data=data,
        records=records,
        exhausted=exhausted,
        decimal=locale.decimal,
        thousands=locale.thousands,
        date_order=locale.date_order,
        text_dates=locale.text_dates,
        notes=notes,
        truncated_columns=truncated,
        crs=options.get("crs"),
    )
