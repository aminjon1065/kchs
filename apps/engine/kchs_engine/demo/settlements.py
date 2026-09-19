"""Населённые пункты демо-мира как уровень `settlement` справочника территорий (ADR-0067).

Кишлаки районов (`world.py`) — синтетические: распространённые топонимы, приписанные
районам случайно, с координатами вокруг центра района. API загружает их в справочник
только в демо-профиле сида (`apps/api/src/seed/settlements.json`): внутренний геокодер
находит пункт по названию, а обратное геокодирование — ближайший пункт.

Запуск из `apps/engine`: `python -m kchs_engine.demo.settlements --out
../api/src/seed/settlements.json`, затем `pnpm exec biome format --write
apps/api/src/seed/settlements.json`; совпадение файла с генератором проверяет
`tests/test_settlements.py`.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from kchs_engine.demo import DEFAULT_SEED
from kchs_engine.demo.world import build_districts

KIND = "кишлак"

# Кириллица (русская и таджикская) → латиница: упрощённая BGN/PCGN, как у английских
# названий справочника («Kulob», «Hisor», «Roghun»)
_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "gh", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "ӣ": "i", "й": "y", "к": "k", "қ": "q", "л": "l",
    "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ӯ": "u", "ф": "f", "х": "kh", "ҳ": "h", "ц": "ts", "ч": "ch", "ҷ": "j", "ш": "sh",
    "щ": "shch", "ъ": "'", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}  # fmt: skip


def transliterate(text: str) -> str:
    """Латинское написание названия: регистр первой буквы сохраняется («Ч» → «Ch»)."""
    out: list[str] = []
    for char in text:
        latin = _LATIN.get(char.lower())
        if latin is None:
            out.append(char)
        elif char.isupper() and latin:
            out.append(latin[0].upper() + latin[1:])
        else:
            out.append(latin)
    return "".join(out)


def settlement_items(seed: int = DEFAULT_SEED) -> list[dict[str, Any]]:
    """Кишлаки всех районов: код `<район>-NN` по порядку генератора, родитель — район."""
    items: list[dict[str, Any]] = []
    for district in build_districts(seed):
        villages = [place for place in district.places if place.village]
        for index, place in enumerate(villages, start=1):
            items.append(
                {
                    "code": f"{district.code}-{index:02d}",
                    "parent": district.code,
                    "level": "settlement",
                    "kind": KIND,
                    "name": {"ru": place.name, "tg": place.name, "en": transliterate(place.name)},
                    "centroid": [round(place.lon, 5), round(place.lat, 5)],
                }
            )
    items.sort(key=lambda item: str(item["code"]))
    return items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m kchs_engine.demo.settlements",
        description="Населённые пункты демо-мира для справочника территорий API (ADR-0067).",
    )
    parser.add_argument("--out", required=True, help="apps/api/src/seed/settlements.json")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)
    items = settlement_items(args.seed)
    Path(args.out).write_text(
        json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{len(items)} населённых пунктов → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
