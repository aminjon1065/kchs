"""Ограждение GDAL/OGR: движок открывает геофайлы только драйверами заявленных
форматов и без обращений к сети или к посторонним файлам (разбор безопасности).

GDAL определяет драйвер по содержимому файла, а не по расширению. Поэтому файл
с расширением геоформата, но с содержимым описания источника (драйвер OGR VRT и
подобные), по умолчанию открывался бы как ссылка на посторонний файл или сетевой
адрес. Список пропускаемых драйверов GDAL читает один раз при регистрации, поэтому
переменные окружения задаются до первой загрузки GDAL (через pyogrio).

Поддерживаемые форматы (Shapefile, GeoPackage, KML/KMZ, GPX, GeoJSON) своими
драйверами остаются доступны: они не входят в список пропуска.
"""

import os

# Драйверы OGR, которые читают посторонний источник (файл, базу, сеть) по описанию
# внутри загруженного файла. Среди поддерживаемых форматов их нет.
_OGR_SKIP = (
    "OGR_VRT",  # описание источника: любой файл, в т.ч. /proc/*, /vsicurl, /vsizip
    "GMLAS",  # догружает XSD-схему, в т.ч. по сети
    "GML",
    "NAS",
    "WFS",
    "OAPIF",
    "CSW",
    "PG",
    "PostgreSQL",
    "MySQL",
    "MSSQLSpatial",
    "ODBC",
    "OCI",
    "PGDUMP",
    "MongoDBv3",
    "Elasticsearch",
    "Carto",
    "AmigoCloud",
    "NGW",
    "WAsP",
    "Selafin",
    "HTTP",  # драйвер, открывающий URL
    "XLSX",  # книги Excel движок читает своим кодом, не через GDAL
    "XLS",
    "ODS",
)
# Растровые драйверы сети и описаний источника (растры движок не импортирует, но
# на случай будущих путей открытия — тоже вне доступа).
_GDAL_SKIP = ("VRT", "HTTP", "WMS", "WCS", "WMTS", "STACTA", "STACIT")


def apply_gdal_hardening() -> None:
    """Запрет небезопасных драйверов GDAL/OGR. Вызывается до загрузки GDAL.

    `setdefault`: заданное снаружи (Dockerfile, compose) значение не перетирается,
    но добавляет к списку наши драйверы, если их там ещё нет.
    """
    _merge_skip("OGR_SKIP", _OGR_SKIP)
    _merge_skip("GDAL_SKIP", _GDAL_SKIP)


def _merge_skip(name: str, drivers: tuple[str, ...]) -> None:
    existing = [d for d in os.environ.get(name, "").replace(",", " ").split() if d]
    merged = list(dict.fromkeys(existing + list(drivers)))
    os.environ[name] = ",".join(merged)


def harden_runtime_config() -> None:
    """Сетевые обращения GDAL (если драйвер их всё же инициирует) — с коротким
    тайм-аутом и без повторов. Вызывается после импорта pyogrio."""
    try:
        from pyogrio import set_gdal_config_options
    except ImportError:  # pragma: no cover — образ движка ставит группу gis
        return
    set_gdal_config_options(
        {
            "GDAL_HTTP_TIMEOUT": "10",
            "GDAL_HTTP_CONNECTTIMEOUT": "5",
            "GDAL_HTTP_MAX_RETRY": "0",
            # Нераспознанные расширения через /vsicurl не кэшируются и не гадаются
            "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": "",
        }
    )
