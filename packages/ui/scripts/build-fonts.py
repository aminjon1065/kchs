"""Сборка веб-шрифтов дизайн-системы (03-ui/02-design-system.md §Типографика, P0-E13 S03).

Источники закреплены по версии и SHA-256:
- Inter 4.1 и JetBrains Mono 2.304 — релизы авторов: в сборках Google Fonts нет
  функций cv11/ss01 Inter, которые включает base.css;
- Noto Sans Mono 5.3.0 (@fontsource-variable) — восполняет таджикские Ӣӣ Ӯӯ Ҳҳ,
  которых нет в JetBrains Mono ни в одной сборке; ширина знака та же (0,6 em).

Подмножества latin, cyrillic и cyrillic-ext с диапазонами Google Fonts (cyrillic-ext
несёт таджикские Ғғ Ӣӣ Ққ Ӯӯ Ҳҳ Ҷҷ). Inter фиксируется на оптическом размере 14
(текст интерфейса) с осью насыщенности 100–900; JetBrains Mono — 100–800.
Результат — packages/ui/src/fonts/*.woff2 и лицензии OFL рядом; @font-face —
в src/styles/fonts.css.

Запуск (нужны интернет и Python 3.11+), из корня репозитория:
    python3 -m venv /tmp/kchs-fonts
    /tmp/kchs-fonts/bin/pip install fonttools brotli
    /tmp/kchs-fonts/bin/python packages/ui/scripts/build-fonts.py
"""

from __future__ import annotations

import hashlib
import io
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = Path(__file__).resolve().parents[1] / 'src' / 'fonts'
CACHE = Path(tempfile.gettempdir()) / 'kchs-fonts-cache'

TAJIK = 'ҒғӢӣҚқӮӯҲҳҶҷ'
# Таджикские буквы, которых нет в JetBrains Mono: берутся из Noto Sans Mono
MONO_SUPPLEMENT = 'ӢӣӮӯҲҳ'

# Диапазоны подмножеств Google Fonts — те же, что в unicode-range fonts.css
SUBSETS = {
    'latin': 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,'
    'U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    'cyrillic': 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
    'cyrillic-ext': 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F',
}


@dataclass(frozen=True)
class Source:
    url: str
    sha256: str


INTER = Source(
    'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    '9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e',
)
JETBRAINS_MONO = Source(
    'https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip',
    '6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf',
)
NOTO_SANS_MONO = Source(
    'https://registry.npmjs.org/@fontsource-variable/noto-sans-mono/-/noto-sans-mono-5.3.0.tgz',
    'ea1483e3421f858e5c05e79966b65d6934f6a7dcee9e8f5b56acfef4c289602c',
)

# Функции OpenType сверх набора fontTools по умолчанию (kern, liga, calt, locl, mark…):
# табличные и пропорциональные цифры, регистр, cv11 (однокруглая «a»), ss01 (открытые цифры)
INTER_FEATURES = ['tnum', 'pnum', 'case', 'cv11', 'ss01', 'zero']


def download(source: Source) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / source.sha256
    if not cached.exists():
        with urllib.request.urlopen(source.url, timeout=120) as response:  # noqa: S310 — закреплённый https-адрес
            cached.write_bytes(response.read())
    data = cached.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != source.sha256:
        cached.unlink()
        raise SystemExit(f'контрольная сумма не совпала: {source.url} ({digest})')
    return data


def from_zip(data: bytes, member: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(member)


def from_tgz(data: bytes, member: str) -> bytes:
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(f'нет файла {member} в архиве')
        return extracted.read()


def codepoints(ranges: str) -> list[int]:
    result: list[int] = []
    for part in ranges.split(','):
        body = part.strip().removeprefix('U+')
        if '-' in body:
            low, high = body.split('-')
            result.extend(range(int(low, 16), int(high, 16) + 1))
        else:
            result.append(int(body, 16))
    return result


def write_subset(font_data: bytes, unicodes: list[int], features: list[str], target: Path) -> TTFont:
    options = subset.Options()
    options.layout_features = [*options.layout_features, *features]
    options.flavor = 'woff2'
    options.hinting = False
    options.name_IDs = ['*']  # имена и строки лицензии остаются в файле
    options.notdef_outline = True
    font = TTFont(io.BytesIO(font_data))
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(target)
    print(f'  {target.name}: {target.stat().st_size / 1024:.1f} КБ')
    return TTFont(target)


def covered(font: TTFont, letters: str) -> str:
    cmap = font.getBestCmap()
    return ''.join(letter for letter in letters if ord(letter) in cmap)


def to_bytes(font: TTFont) -> bytes:
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    inter_zip = download(INTER)
    mono_zip = download(JETBRAINS_MONO)
    noto_tgz = download(NOTO_SANS_MONO)

    # Inter: оптический размер 14 — текст интерфейса; ось насыщенности остаётся
    inter = instancer.instantiateVariableFont(
        TTFont(io.BytesIO(from_zip(inter_zip, 'InterVariable.ttf'))), {'opsz': 14}
    )
    inter_data = to_bytes(inter)
    mono_data = from_zip(mono_zip, 'fonts/variable/JetBrainsMono[wght].ttf')

    print('Inter 4.1 (opsz 14, wght 100–900):')
    inter_ext = None
    for name, ranges in SUBSETS.items():
        font = write_subset(inter_data, codepoints(ranges), INTER_FEATURES, OUT / f'inter-{name}.woff2')
        if name == 'cyrillic-ext':
            inter_ext = font

    print('JetBrains Mono 2.304 (wght 100–800):')
    mono_ext = None
    for name, ranges in SUBSETS.items():
        font = write_subset(mono_data, codepoints(ranges), [], OUT / f'jetbrains-mono-{name}.woff2')
        if name == 'cyrillic-ext':
            mono_ext = font

    print('Noto Sans Mono 5.3.0 — таджикские буквы для моноширинного текста:')
    noto = from_tgz(noto_tgz, 'package/files/noto-sans-mono-cyrillic-ext-wght-normal.woff2')
    supplement = write_subset(
        noto, [ord(letter) for letter in MONO_SUPPLEMENT], [], OUT / 'noto-sans-mono-tajik.woff2'
    )

    # Таджикский алфавит обязан рисоваться своими шрифтами, а не системным фолбэком
    assert inter_ext is not None and mono_ext is not None
    if covered(inter_ext, TAJIK) != TAJIK:
        raise SystemExit(f'Inter cyrillic-ext без таджикских букв: есть только {covered(inter_ext, TAJIK)}')
    mono_letters = covered(mono_ext, TAJIK) + covered(supplement, TAJIK)
    missing = [letter for letter in TAJIK if letter not in mono_letters]
    if missing:
        raise SystemExit(f'моноширинному шрифту не хватает: {"".join(missing)}')

    (OUT / 'OFL-Inter.txt').write_bytes(from_zip(inter_zip, 'LICENSE.txt'))
    (OUT / 'OFL-JetBrainsMono.txt').write_bytes(from_zip(mono_zip, 'OFL.txt'))
    (OUT / 'OFL-NotoSansMono.txt').write_bytes(from_tgz(noto_tgz, 'package/LICENSE'))
    print(f'Готово: {OUT}')


if __name__ == '__main__':
    main()
