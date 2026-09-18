"""Ключ поля из заголовка столбца: латиница snake_case (`^[a-z_][a-z0-9_]*$`, ≤ 64).

Кириллица — русская и таджикская — транслитерируется, латиница с диакритикой
сводится к базовой букве. Ключ не начинается с «_»: такие имена занимают
системные столбцы таблиц датасетов (`_id`, `_ver`, `_created_at`…).
"""

import re
import unicodedata

KEY_MAX_LENGTH = 64

_TRANSLIT = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "yo",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
    # таджикские буквы
    "ғ": "gh",
    "ӣ": "i",
    "қ": "q",
    "ӯ": "u",
    "ҳ": "h",
    "ҷ": "j",
    # украинские и казахские — встречаются в выгрузках соседних систем
    "і": "i",
    "ї": "yi",
    "є": "ye",
    "ґ": "g",
    "ә": "a",
    "ө": "o",
    "ү": "u",
    "ң": "ng",
    "ұ": "u",
    "№": "no",
}

_NOT_WORD = re.compile(r"[^a-z0-9]+")


def transliterate(text: str) -> str:
    parts: list[str] = []
    for char in text.lower():
        replacement = _TRANSLIT.get(char)
        if replacement is not None:
            parts.append(replacement)
            continue
        decomposed = unicodedata.normalize("NFKD", char)
        parts.append("".join(c for c in decomposed if not unicodedata.combining(c)))
    return "".join(parts)


def field_key(header: str, index: int) -> str:
    """Ключ из заголовка; пустой заголовок — `column_<номер>`."""
    fallback = f"column_{index + 1}"
    key = _NOT_WORD.sub("_", transliterate(header)).strip("_")
    if not key:
        return fallback
    if key[0].isdigit():
        key = f"f_{key}"
    return key[:KEY_MAX_LENGTH].rstrip("_") or fallback


def unique_keys(headers: list[str], indexes: list[int] | None = None) -> list[str]:
    """Ключи для всех столбцов без повторов: второй «summa» — `summa_2`.

    `indexes` — номера столбцов в файле (для ключей безымянных столбцов).
    """
    seen: set[str] = set()
    keys: list[str] = []
    positions = indexes if indexes is not None else list(range(len(headers)))
    for index, header in zip(positions, headers, strict=True):
        base = field_key(header, index)
        key = base
        counter = 2
        while key in seen:
            suffix = f"_{counter}"
            key = base[: KEY_MAX_LENGTH - len(suffix)].rstrip("_") + suffix
            counter += 1
        seen.add(key)
        keys.append(key)
    return keys
