"""Минимальные спрайты подложки: населённый пункт, столица, вершина (ADR-0066).

Цвета «зашиты» по темам light/dark/muted из токенов дизайн-системы — так
значки читаются на своей подложке без SDF. Только стандартная библиотека:
фигуры рисуются с суперсэмплингом 4×4, PNG собирается вручную (zlib).

    python3 sprites.py <каталог>   # basemap-{тема}.json/png и @2x
"""

import json
import struct
import sys
import zlib
from pathlib import Path

# Токены дизайн-системы (packages/ui/src/tokens/tokens.json): текст и фон холста
THEMES = {
    "light": {"ink": "#4F5160", "strong": "#17181C", "soft": "#666875", "halo": "#F6F6F7"},
    "dark": {"ink": "#A6A7B2", "strong": "#ECECEF", "soft": "#8A8C99", "halo": "#0E0F11"},
    "muted": {"ink": "#666875", "strong": "#4F5160", "soft": "#8A8C99", "halo": "#FFFFFF"},
}
SAMPLES = 4

Color = tuple[int, int, int]


def rgb(value: str) -> Color:
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def disc(cx: float, cy: float, r: float):
    return lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def triangle(cx: float, top: float, bottom: float, half: float):
    def inside(x: float, y: float) -> bool:
        if y < top or y > bottom:
            return False
        spread = half * (y - top) / (bottom - top)
        return abs(x - cx) <= spread

    return inside


class Canvas:
    """RGBA-холст; фигура закрашивается с долей покрытия пикселя (сглаживание)."""

    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height
        self.pixels = [[(0, 0, 0, 0.0)] * width for _ in range(height)]

    def fill(self, inside, color: Color) -> None:
        for py in range(self.height):
            for px in range(self.width):
                hits = 0
                for sy in range(SAMPLES):
                    for sx in range(SAMPLES):
                        if inside(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES):
                            hits += 1
                if hits == 0:
                    continue
                alpha = hits / (SAMPLES * SAMPLES)
                r0, g0, b0, a0 = self.pixels[py][px]
                out = alpha + a0 * (1 - alpha)
                blend = [
                    (channel * alpha + base * a0 * (1 - alpha)) / out
                    for channel, base in zip(color, (r0, g0, b0), strict=True)
                ]
                self.pixels[py][px] = (blend[0], blend[1], blend[2], out)

    def png(self) -> bytes:
        rows = bytearray()
        for row in self.pixels:
            rows.append(0)
            for r, g, b, a in row:
                rows += bytes((round(r), round(g), round(b), round(a * 255)))

        def chunk(kind: bytes, data: bytes) -> bytes:
            body = kind + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

        header = struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b"")
        )


def icons(scale: int, theme: dict[str, str]):
    """Значки: (имя, сторона в пикселях, отрисовка на холсте со смещением)."""
    halo, ink, strong, soft = (rgb(theme[k]) for k in ("halo", "ink", "strong", "soft"))

    def city(canvas: Canvas, x0: int) -> None:
        c = x0 + 5 * scale
        canvas.fill(disc(c, 5 * scale, 4.5 * scale), halo)
        canvas.fill(disc(c, 5 * scale, 3 * scale), ink)

    def capital(canvas: Canvas, x0: int) -> None:
        c = x0 + 7 * scale
        canvas.fill(disc(c, 7 * scale, 6.5 * scale), halo)
        canvas.fill(disc(c, 7 * scale, 5 * scale), strong)
        canvas.fill(disc(c, 7 * scale, 3.5 * scale), halo)
        canvas.fill(disc(c, 7 * scale, 2 * scale), strong)

    def peak(canvas: Canvas, x0: int) -> None:
        c = x0 + 6 * scale
        canvas.fill(triangle(c, 0.5 * scale, 10.5 * scale, 6 * scale), halo)
        canvas.fill(triangle(c, 2.5 * scale, 9.5 * scale, 4.3 * scale), soft)

    return [
        ("city", 10 * scale, city),
        ("capital", 14 * scale, capital),
        ("peak", 12 * scale, peak),
    ]


def build(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, theme in THEMES.items():
        for scale in (1, 2):
            items = icons(scale, theme)
            width = sum(size for _, size, _ in items) + len(items) * scale
            height = max(size for _, size, _ in items)
            canvas = Canvas(width, height)
            index: dict[str, dict[str, int]] = {}
            x = 0
            for icon, size, draw in items:
                draw(canvas, x)
                index[icon] = {"x": x, "y": 0, "width": size, "height": size, "pixelRatio": scale}
                x += size + scale
            suffix = "" if scale == 1 else "@2x"
            stem = f"basemap-{name}{suffix}"
            (directory / f"{stem}.png").write_bytes(canvas.png())
            (directory / f"{stem}.json").write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("использование: sprites.py <каталог>")
    build(Path(sys.argv[1]))
