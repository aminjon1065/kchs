"""Значения, ключи полей и геометрия импорта датасетов (ADR-0046)."""

from datetime import date, datetime, timedelta, timezone

import pytest

from kchs_engine.data.geometry import (
    GeometryError,
    any_to_ewkt,
    geojson_to_ewkt,
    point_ewkt,
    wkt_to_ewkt,
)
from kchs_engine.data.keys import field_key, transliterate, unique_keys
from kchs_engine.data.values import (
    cell_text,
    clean_text,
    dump_json,
    excel_serial_date,
    format_datetime,
    format_float,
    parse_boolean,
    parse_date,
    parse_integer,
    parse_number,
    parse_time,
    resolve_zone,
)


def number(raw: str, decimal: str) -> str | None:
    parsed = parse_number(raw, decimal)
    return parsed.text if parsed else None


def test_числа_с_локалью() -> None:
    # Разделители тысяч: пробел, неразрывный, узкий неразрывный, апостроф, точка при запятой
    assert number("1 234 567,89", ",") == "1234567.89"
    assert number("1\u00a0234\u00a0567,89", ",") == "1234567.89"
    assert number("2\u202f000,5", ",") == "2000.5"
    assert number("1'234.5", ".") == "1234.5"
    assert number("1.234.567,89", ",") == "1234567.89"
    assert number("1,234,567.89", ".") == "1234567.89"
    # Бухгалтерская запись отрицательного, типографский минус, знак «+»
    assert number("(1 500)", ",") == "-1500"
    assert number("−250,5", ",") == "-250.5"
    assert number("+7", ".") == "7"
    # Проценты
    parsed = parse_number("12,5%", ",")
    assert parsed is not None and parsed.text == "12.5" and parsed.percent
    # Не числа
    assert number("12,5", ".") is None
    assert number("1.2.3", ",") is None
    assert number("abc", ".") is None
    assert number("١٢٣", ".") is None  # цифры не ASCII Postgres не примет
    assert number("", ".") is None


def test_целые() -> None:
    assert parse_integer("1 234", ",") == "1234"
    assert parse_integer("12,0", ",") == "12"
    assert parse_integer("-007", ".") == "-7"
    assert parse_integer("12,5", ",") is None
    assert parse_integer("9223372036854775807", ".") == "9223372036854775807"
    assert parse_integer("9223372036854775808", ".") is None
    assert parse_integer("1e3", ".") == "1000"


def test_логические() -> None:
    for token in ("да", "Да", "ДА", "true", "1", "yes", "ҳа", "+", "✓"):
        assert parse_boolean(token) == "true", token
    for token in ("нет", "Нет", "false", "0", "no", "н"):
        assert parse_boolean(token) == "false", token
    assert parse_boolean("может быть") is None


@pytest.mark.parametrize(
    ("raw", "order", "expected", "pattern"),
    [
        ("18.09.2026", "dmy", datetime(2026, 9, 18), "dd.MM.yyyy"),
        ("2026-09-18", "dmy", datetime(2026, 9, 18), "yyyy-MM-dd"),
        ("18/09/26", "dmy", datetime(2026, 9, 18), "dd/MM/yy"),
        ("09/18/2026", "mdy", datetime(2026, 9, 18), "MM/dd/yyyy"),
        # Значение само говорит о порядке: 18 не может быть месяцем
        ("18.09.2026", "mdy", datetime(2026, 9, 18), "dd.MM.yyyy"),
        ("01.02.2026", "mdy", datetime(2026, 1, 2), "MM.dd.yyyy"),
        ("18 сентября 2026 г.", "dmy", datetime(2026, 9, 18), "d MMMM yyyy"),
        ("18-Sep-2026", "dmy", datetime(2026, 9, 18), "d MMMM yyyy"),
        ("Sep 18, 2026", "dmy", datetime(2026, 9, 18), "MMMM d yyyy"),
        ("18.09.2026 14:30", "dmy", datetime(2026, 9, 18, 14, 30), "dd.MM.yyyy HH:mm"),
    ],
)
def test_даты(raw: str, order: str, expected: datetime, pattern: str) -> None:
    parsed = parse_date(raw, order, today=date(2026, 9, 18))
    assert parsed is not None
    assert parsed.value == expected
    assert parsed.pattern == pattern


def test_даты_неверные_и_двузначный_год() -> None:
    assert parse_date("31.02.2026") is None
    assert parse_date("2026") is None
    assert parse_date("вчера") is None
    # Двузначный год: будущее — не дальше 5 лет
    assert parse_date("01.01.30", today=date(2026, 9, 18)).value.year == 2030  # type: ignore[union-attr]
    assert parse_date("01.01.58", today=date(2026, 9, 18)).value.year == 1958  # type: ignore[union-attr]


def test_серийные_даты_excel_и_время() -> None:
    assert excel_serial_date(46283) == datetime(2026, 9, 18)
    assert excel_serial_date(46283.5) == datetime(2026, 9, 18, 12, 0)
    assert excel_serial_date(0) is None
    assert parse_time("14:30") is not None and parse_time("14:30").isoformat() == "14:30:00"  # type: ignore[union-attr]
    assert parse_time("2:05 PM").isoformat() == "14:05:00"  # type: ignore[union-attr]
    assert parse_time("25:00") is None


def test_дата_со_смещением_и_пояс_организации() -> None:
    zone = resolve_zone("Asia/Dushanbe")
    assert format_datetime(datetime(2026, 9, 18, 14, 30), None, zone) == "2026-09-18T14:30:00+05:00"
    assert (
        format_datetime(datetime(2026, 9, 18, 14, 30), timedelta(hours=3), zone)
        == "2026-09-18T14:30:00+03:00"
    )
    parsed = parse_date("2026-09-18T14:30:00Z")
    assert parsed is not None and parsed.offset == timedelta(0)
    assert resolve_zone("Нет/Такого").utcoffset(None) == timezone(timedelta(hours=5)).utcoffset(
        None
    )


def test_текст_ячейки_как_видит_человек() -> None:
    assert cell_text("  Вахдат\u00a0") == "Вахдат"
    assert cell_text(992935001122.0) == "992935001122"
    assert cell_text(1e-20) == "0.00000000000000000001"
    assert cell_text(datetime(2026, 9, 18)) == "2026-09-18"
    assert cell_text({"a": 1}) == '{"a": 1}'
    assert format_float(2.5) == "2.5"
    assert clean_text("a\r\nb\tc\x07") == "a\nb c"


def test_json_для_jsonb() -> None:
    assert dump_json({"город": "Душанбе", "n": [1, 2]}) == '{"город":"Душанбе","n":[1,2]}'
    # NUL jsonb не хранит — символ убирается; NaN — не JSON
    assert dump_json({"a": "x\x00y"}) == '{"a":"xy"}'
    with pytest.raises(ValueError):
        dump_json({"a": float("nan")})


def test_ключи_полей_транслитерацией() -> None:
    assert transliterate("Щёлково") == "shchyolkovo"
    assert field_key("Район", 0) == "rayon"
    assert field_key("Площадь, км²", 0) == "ploshchad_km2"
    # Таджикские буквы ғ ӣ қ ӯ ҳ ҷ
    assert field_key("Ноҳия", 0) == "nohiya"
    assert field_key("Шумораи аҳолӣ", 0) == "shumorai_aholi"
    assert field_key("Ғарм, Қӯрғонтеппа, Ҷ", 0) == "gharm_qurghonteppa_j"
    assert field_key("2025 год", 0) == "f_2025_god"
    assert field_key("№ п/п", 0) == "no_p_p"
    # Системные имена таблиц датасетов начинаются с «_» — ключ поля так не начинается
    assert field_key("_id", 0) == "id"
    assert field_key("___", 4) == "column_5"
    assert field_key("", 2) == "column_3"
    assert len(field_key("очень длинное название " * 10, 0)) <= 64


def test_ключи_без_повторов() -> None:
    assert unique_keys(["Сумма", "Сумма", "summa", ""], [0, 1, 2, 7]) == [
        "summa",
        "summa_2",
        "summa_3",
        "column_8",
    ]


def test_wkt_в_ewkt() -> None:
    assert wkt_to_ewkt("POINT(68.78 38.56)") == "SRID=4326;POINT(68.78 38.56)"
    assert wkt_to_ewkt("SRID=4326;point (68 38)") == "SRID=4326;POINT(68 38)"
    # Z и M отбрасываются — столбец двумерный
    assert wkt_to_ewkt("POINT Z (68 38 850)") == "SRID=4326;POINT(68 38)"
    assert (
        wkt_to_ewkt("MULTIPOLYGON(((68 38,69 38,69 39,68 38)))")
        == "SRID=4326;MULTIPOLYGON(((68 38,69 38,69 39,68 38)))"
    )
    assert wkt_to_ewkt("POLYGON EMPTY") == "SRID=4326;POLYGON EMPTY"
    for broken, reason in [
        ("POLYGON((68 38,69 38,69 39,68 39))", "не замкнуто"),
        ("SRID=3857;POINT(1 2)", "EPSG:3857"),
        ("POINT(200 10)", "долгота"),
        ("POINT(10 95)", "широта"),
        ("LINESTRING(1 1)", "не меньше 2"),
        ("CIRCLE(1 2)", "неизвестный"),
        ("POINT(1 2) лишнее", "непонятный"),
    ]:
        with pytest.raises(GeometryError, match=reason):
            wkt_to_ewkt(broken)


def test_geojson_и_точки() -> None:
    polygon = {"type": "Polygon", "coordinates": [[[68, 38], [69, 38], [69, 39], [68, 38]]]}
    assert geojson_to_ewkt(polygon) == "SRID=4326;POLYGON((68 38,69 38,69 39,68 38))"
    assert any_to_ewkt('{"type": "Point", "coordinates": [68.7, 38.5, 850]}') == (
        "SRID=4326;POINT(68.7 38.5)"
    )
    assert point_ewkt("68.7870", "38.5598") == "SRID=4326;POINT(68.787 38.5598)"
    with pytest.raises(GeometryError):
        geojson_to_ewkt({"type": "Point", "coordinates": ["a", 1]})
    with pytest.raises(GeometryError):
        point_ewkt("68", "91")
