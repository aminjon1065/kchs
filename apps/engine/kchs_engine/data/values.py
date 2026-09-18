"""Разбор и нормализация значений ячеек (ADR-0046).

Значение приходит строкой (CSV, текстовые ячейки Excel) или типизированным
(числа и даты Excel, значения JSON). Функции разбора возвращают каноническую
запись для нормализованного CSV (`NORMALIZED_VALUE_FORMATS` контракта) или
`None`, если значение не приводится к типу. Пустые значения и принятые в
отчётах заглушки («—», «н/д») для не текстовых типов — NULL, а не ошибка.
"""

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ─── Пустые значения ─────────────────────────────────────────────────────────

# Заглушки вместо значения в отчётах; для текстовых полей остаются текстом
NULL_TOKENS = frozenset(
    {
        "",
        "-",
        "—",
        "–",
        "−",
        "н/д",
        "н.д.",
        "нет данных",
        "n/a",
        "#н/д",
        "#n/a",
        "null",
        "none",
        "nan",
        "(пусто)",
    }
)

# Пробелы, которыми разделяют разряды: обычный, неразрывный, узкий неразрывный, тонкий
_SPACES = " \u00a0\u202f\u2009\u2007"
_STRIP = _SPACES + "\t\r\n"
# Что обрезается по краям значения
STRIP_CHARS = _STRIP


def is_null_token(text: str) -> bool:
    return text.strip(_STRIP).lower() in NULL_TOKENS


def is_blank(value: object) -> bool:
    """Пустая ячейка: нет значения или только пробелы."""
    if value is None:
        return True
    return isinstance(value, str) and not value.strip(_STRIP)


def strip_text(text: str) -> str:
    """Обрезка пробелов, включая неразрывные."""
    return text.strip(_STRIP)


def cell_text(value: object) -> str | None:
    """Значение ячейки текстом — так, как его видит человек (предпросмотр, примеры, ошибки)."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip(_STRIP)
        return text or None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format_float(value)
    if isinstance(value, datetime):
        if value.hour == value.minute == value.second == value.microsecond == 0:
            return value.date().isoformat()
        return value.replace(microsecond=0).isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False)
    text = str(value).strip(_STRIP)
    return text or None


def format_float(value: float) -> str:
    """Число без экспоненты и без «.0» у целых: 992935001122.0 → «992935001122»."""
    if value != value or value in (float("inf"), float("-inf")):
        return str(value)
    if value.is_integer() and abs(value) < 1e18:
        return str(int(value))
    text = repr(value)
    if "e" in text or "E" in text:
        # 1e-20 → «0.00000000000000000001»: кратчайшая запись без экспоненты
        text = format(Decimal(text), "f")
    return text


# ─── Числа ───────────────────────────────────────────────────────────────────

# Только цифры ASCII: «١٢٣» Postgres в числовой столбец не примет
_NUMERIC = re.compile(r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", re.ASCII)
_GROUPED_DOT = re.compile(r"\d{1,3}(?:\.\d{3})+", re.ASCII)
_GROUPED_COMMA = re.compile(r"\d{1,3}(?:,\d{3})+", re.ASCII)
_DROP_SPACES = str.maketrans("", "", _SPACES + "'")


@dataclass(frozen=True, slots=True)
class ParsedNumber:
    """Каноническая запись числа и признак знака «%»."""

    text: str
    percent: bool


def parse_number(raw: str, decimal: str) -> ParsedNumber | None:
    """Число из текста с учётом десятичного знака и разделителей тысяч.

    «1 234,56» и «1.234,56» при десятичной запятой, «1,234.56» при точке,
    «(123)» — отрицательное (бухгалтерская запись), «12,5%» — проценты.
    Каноническая запись сохраняет цифры как есть: деньги не теряют копейки
    на двоичной плавающей точке.
    """
    text = raw.strip(_STRIP)
    if not text:
        return None
    percent = text.endswith("%")
    if percent:
        text = text[:-1].rstrip(_STRIP)
    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip(_STRIP)
    text = text.replace("−", "-")
    if text.startswith("+"):
        text = text[1:]
    elif text.startswith("-"):
        negative = not negative
        text = text[1:]
    text = text.translate(_DROP_SPACES)
    if decimal == ",":
        whole = text.split(",", 1)[0]
        if "." in whole:
            # Точки при десятичной запятой — только разделители тысяч: 1.234.567,89
            if not _GROUPED_DOT.fullmatch(whole):
                return None
            text = text.replace(".", "", whole.count("."))
        if text.count(",") > 1:
            return None
        text = text.replace(",", ".")
    else:
        whole = text.split(".", 1)[0]
        if "," in whole:
            if not _GROUPED_COMMA.fullmatch(whole):
                return None
            text = text.replace(",", "", whole.count(","))
        if "," in text:
            return None
    if not _NUMERIC.fullmatch(text):
        return None
    if negative and text.strip("0.") != "":
        text = "-" + text
    return ParsedNumber(text, percent)


_INT64_MAX = 2**63 - 1


def parse_integer(raw: str, decimal: str) -> str | None:
    """Целое: «1 234», «12.0» → «12»; дробное — не целое."""
    number = parse_number(raw, decimal)
    if number is None or number.percent:
        return None
    text = number.text
    if "e" in text or "E" in text:
        try:
            value = float(text)
        except ValueError:
            return None
        if not value.is_integer():
            return None
        text = str(int(value))
    elif "." in text:
        whole, fraction = text.split(".", 1)
        if fraction.strip("0"):
            return None
        text = whole or "0"
    sign = "-" if text.startswith("-") else ""
    digits = text.lstrip("-").lstrip("0") or "0"
    if len(digits) > 19 or int(digits) > _INT64_MAX:
        return None
    return sign + digits if digits != "0" else "0"


def number_from_native(value: object) -> str | None:
    """Число из типизированной ячейки (Excel, JSON)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return format_float(value)
    return None


# ─── Логические значения ─────────────────────────────────────────────────────

TRUE_TOKENS = frozenset(
    {"true", "t", "yes", "y", "да", "д", "истина", "ҳа", "ха", "вкл", "1", "+", "✓", "✔"}
)
FALSE_TOKENS = frozenset({"false", "f", "no", "n", "нет", "н", "ложь", "не", "выкл", "0"})


def parse_boolean(raw: str) -> str | None:
    token = raw.strip(_STRIP).lower()
    if token in TRUE_TOKENS:
        return "true"
    if token in FALSE_TOKENS:
        return "false"
    return None


# ─── Даты и время ────────────────────────────────────────────────────────────

MONTHS = {
    # русские: именительный, родительный и сокращения
    "январь": 1,
    "января": 1,
    "янв": 1,
    "февраль": 2,
    "февраля": 2,
    "фев": 2,
    "март": 3,
    "марта": 3,
    "мар": 3,
    "апрель": 4,
    "апреля": 4,
    "апр": 4,
    "май": 5,
    "мая": 5,
    "июнь": 6,
    "июня": 6,
    "июн": 6,
    "июль": 7,
    "июля": 7,
    "июл": 7,
    "август": 8,
    "августа": 8,
    "авг": 8,
    "сентябрь": 9,
    "сентября": 9,
    "сен": 9,
    "сент": 9,
    "октябрь": 10,
    "октября": 10,
    "окт": 10,
    "ноябрь": 11,
    "ноября": 11,
    "ноя": 11,
    "декабрь": 12,
    "декабря": 12,
    "дек": 12,
    # английские
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}

_TIME_PART = r"(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?"
_ZONE_PART = r"\s*(Z|[+-]\d{2}(?::?\d{2})?)?"

_ISO = re.compile(
    r"(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T\s]+" + _TIME_PART + _ZONE_PART + r")?", re.I
)
_NUMERIC_DATE = re.compile(
    r"(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?:[T\s,]+" + _TIME_PART + _ZONE_PART + r")?", re.I
)
_TEXT_DATE_DMY = re.compile(
    r"(\d{1,2})[\s.\-]+([^\W\d_]+)\.?[\s.\-,]+(\d{4})(?:\s*г\.?)?(?:[T\s,]+" + _TIME_PART + r")?",
    re.I,
)
_TEXT_DATE_MDY = re.compile(
    r"([^\W\d_]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:[T\s,]+" + _TIME_PART + r")?", re.I
)
_TIME_ONLY = re.compile(_TIME_PART + r"\s*([ap]\.?m\.?)?", re.I)

# Серийные числа дат Excel: 1 — 1900-01-01; эпоха 1899-12-30 учитывает ошибку
# Excel с несуществующим 29.02.1900
_EXCEL_EPOCH = datetime(1899, 12, 30)
EXCEL_SERIAL_MIN = 1
EXCEL_SERIAL_MAX = 2_958_465


@dataclass(frozen=True, slots=True)
class ParsedDate:
    """Разобранная дата/время. `pattern` — распознанный шаблон, `order` — порядок частей."""

    value: datetime
    has_time: bool
    offset: timedelta | None
    pattern: str
    # Свидетельство порядка частей для числовых дат: день > 12 в первой или второй позиции
    evidence: str | None = None


def two_digit_year(year: int, today: date | None = None) -> int:
    """«26» → 2026, «58» → 1958: будущее допускается на 5 лет вперёд."""
    current = (today or date.today()).year
    pivot = current % 100 + 5
    century = current - current % 100
    return century + year if year <= pivot else century - 100 + year


def _offset(zone: str | None) -> timedelta | None:
    if not zone:
        return None
    if zone.upper() == "Z":
        return timedelta(0)
    sign = -1 if zone[0] == "-" else 1
    digits = zone[1:].replace(":", "")
    hours = int(digits[:2])
    minutes = int(digits[2:4]) if len(digits) >= 4 else 0
    return sign * timedelta(hours=hours, minutes=minutes)


def _build(
    year: int,
    month: int,
    day: int,
    time_groups: tuple[str | None, ...] | None,
    zone: str | None,
    pattern: str,
    evidence: str | None = None,
) -> ParsedDate | None:
    hour = minute = second = micro = 0
    has_time = False
    if time_groups and time_groups[0] is not None:
        has_time = True
        hour = int(time_groups[0])
        minute = int(time_groups[1] or 0)
        second = int(time_groups[2] or 0)
        fraction = time_groups[3]
        micro = int((fraction or "0").ljust(6, "0")[:6])
    try:
        value = datetime(year, month, day, hour, minute, second, micro)
    except ValueError:
        return None
    if not 1 <= year <= 9999:
        return None
    return ParsedDate(value, has_time, _offset(zone), pattern, evidence)


def parse_date(raw: str, order: str = "dmy", today: date | None = None) -> ParsedDate | None:
    """Дата или дата со временем из текста.

    ISO (2026-09-18, 2026/09/18, 2026-09-18T14:30+05:00), числовые с порядком
    `order` (18.09.2026, 18/09/26, 09/18/2026 при mdy), с названием месяца
    («18 сентября 2026 г.», «18-Sep-2026», «Sep 18, 2026»).
    """
    text = raw.strip(_STRIP)
    if not text or len(text) > 40:
        return None
    match = _ISO.fullmatch(text)
    if match:
        year, sep, month, day = match.group(1, 2, 3, 4)
        separator = {"-": "-", "/": "/", ".": "."}[sep]
        pattern = f"yyyy{separator}MM{separator}dd"
        groups = match.group(5, 6, 7, 8)
        if groups[0] is not None:
            pattern += " HH:mm"
        return _build(int(year), int(month), int(day), groups, match.group(9), pattern)
    match = _NUMERIC_DATE.fullmatch(text)
    if match:
        first, sep, second, year_text = match.group(1, 2, 3, 4)
        a, b = int(first), int(second)
        evidence = "dmy" if a > 12 >= b else "mdy" if b > 12 >= a else None
        if evidence is not None and evidence != order and order in ("dmy", "mdy"):
            # Значение само говорит о порядке частей — ему и верим
            effective = evidence
        else:
            effective = order if order in ("dmy", "mdy") else "dmy"
        day, month = (a, b) if effective == "dmy" else (b, a)
        year = int(year_text)
        short = len(year_text) == 2
        if short:
            year = two_digit_year(year, today)
        year_token = "yy" if short else "yyyy"
        pattern = (
            f"dd{sep}MM{sep}{year_token}" if effective == "dmy" else f"MM{sep}dd{sep}{year_token}"
        )
        groups = match.group(5, 6, 7, 8)
        if groups[0] is not None:
            pattern += " HH:mm"
        return _build(year, month, day, groups, match.group(9), pattern, evidence)
    match = _TEXT_DATE_DMY.fullmatch(text)
    if match:
        month = MONTHS.get(match.group(2).lower().rstrip("."))
        if month is None:
            return None
        groups = match.group(4, 5, 6, 7)
        return _build(int(match.group(3)), month, int(match.group(1)), groups, None, "d MMMM yyyy")
    match = _TEXT_DATE_MDY.fullmatch(text)
    if match:
        month = MONTHS.get(match.group(1).lower().rstrip("."))
        if month is None:
            return None
        groups = match.group(4, 5, 6, 7)
        return _build(int(match.group(3)), month, int(match.group(2)), groups, None, "MMMM d yyyy")
    return None


def excel_serial_date(serial: float) -> datetime | None:
    """Серийное число даты Excel → дата (дробная часть — время)."""
    if not EXCEL_SERIAL_MIN <= serial <= EXCEL_SERIAL_MAX:
        return None
    value = _EXCEL_EPOCH + timedelta(days=serial)
    # Погрешность плавающей точки: 45123.999999 → округление до секунды
    return value.replace(microsecond=0) + timedelta(seconds=round(value.microsecond / 1e6))


def parse_time(raw: str) -> time | None:
    match = _TIME_ONLY.fullmatch(raw.strip(_STRIP))
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    second = int(match.group(3) or 0)
    meridiem = (match.group(5) or "").lower().replace(".", "")
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem == "pm" else 0)
    try:
        return time(hour, minute, second)
    except ValueError:
        return None


def resolve_zone(name: str | None) -> tzinfo:
    """Пояс организации для дат без смещения (Таджикистан: UTC+5, без перехода на летнее)."""
    try:
        return ZoneInfo(name or "Asia/Dushanbe")
    except (ZoneInfoNotFoundError, ValueError):
        return timezone(timedelta(hours=5))


def format_datetime(parsed: datetime, offset: timedelta | None, zone: tzinfo) -> str:
    """ISO 8601 со смещением: явное смещение значения или пояс организации."""
    if offset is not None:
        aware = parsed.replace(tzinfo=timezone(offset))
    else:
        aware = parsed.replace(tzinfo=zone)
    return aware.isoformat(timespec="microseconds" if parsed.microsecond else "seconds")


# ─── Длина текста ────────────────────────────────────────────────────────────

# Предел длины значения по типу поля (символов): длиннее — ошибка too_long
TEXT_LIMITS = {
    "text": 10_000,
    "select": 1_000,
    "identifier": 1_000,
    "url": 4_000,
    "email": 1_000,
    "phone": 1_000,
    "long_text": 1_000_000,
    "json": 1_000_000,
}


# ─── Прочие распознаваемые типы ──────────────────────────────────────────────

EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s.]{2,}")
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
_PHONE_CHARS = re.compile(r"[\s()\-.]")
PHONE_DIGITS = re.compile(r"\+?\d{7,15}")


def looks_like_phone(raw: str) -> bool:
    text = raw.strip(_STRIP)
    compact = _PHONE_CHARS.sub("", text)
    return bool(PHONE_DIGITS.fullmatch(compact))


def _reject_constant(name: str) -> Any:
    # NaN и Infinity — не JSON: jsonb их не примет
    raise ValueError(name)


def load_json(text: str) -> Any:
    """JSON-текст → значение; NaN/Infinity — ошибка (ValueError)."""
    return json.loads(text, parse_constant=_reject_constant)


def _without_nul(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, list):
        return [_without_nul(item) for item in value]
    if isinstance(value, dict):
        return {str(key).replace("\x00", ""): _without_nul(item) for key, item in value.items()}
    return value


def dump_json(value: Any) -> str:
    """Значение → компактный JSON для jsonb: без NaN (ValueError) и без символа NUL."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if "\\u0000" in text:
        # jsonb не хранит символ NUL (\u0000) — он убирается из строк
        text = json.dumps(
            _without_nul(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
    return text


def parse_json_text(raw: str) -> str | None:
    """Объект или массив JSON из текста ячейки (для распознавания типа json)."""
    text = raw.strip(_STRIP)
    if not text or text[0] not in "{[":
        return None
    try:
        return dump_json(load_json(text))
    except (ValueError, RecursionError):
        return None


# Управляющие символы C0 (кроме перевода строки) и C1; табуляция становится пробелом
_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")


def clean_text(raw: str) -> str:
    """Текст без управляющих символов, кроме перевода строки; табуляция — пробел."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    if _CONTROL.search(text):
        text = _CONTROL.sub(lambda match: " " if match.group(0) == "\t" else "", text)
    return text
