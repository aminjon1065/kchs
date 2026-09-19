/**
 * Поле расстояний (SDF) из маски: MapLibre рисует SDF-изображения любым цветом
 * (`icon-color`) и с ореолом (`icon-halo-*`), как глифы шрифтов. Алгоритм — точное
 * евклидово преобразование расстояний (Felzenszwalb, Huttenlocher) по строкам и
 * столбцам, как в TinySDF: внешнее и внутреннее расстояния до края маски.
 */

const INF = 1e20

/** Запас вокруг фигуры, px: в нём помещается ореол. */
export const SDF_BUFFER = 3
/** Радиус поля, px: расстояния дальше — насыщенные. */
const RADIUS = 8
/** Доля шкалы под «внутри»: край фигуры — значение 191 (0,75), как у глифов MapLibre. */
const CUTOFF = 0.25

/** Одномерное преобразование для одной строки или столбца (на месте). */
function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint16Array,
  z: Float64Array,
): void {
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride] as number
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    do {
      const r = v[k] as number
      s = ((f[q] as number) - (f[r] as number) + q * q - r * r) / (q - r) / 2
    } while (s <= (z[k] as number) && --k > -1)
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  for (let q = 0, k = 0; q < length; q++) {
    while ((z[k + 1] as number) < q) k++
    const r = v[k] as number
    grid[offset + q * stride] = (f[r] as number) + (q - r) * (q - r)
  }
}

function edt(grid: Float64Array, width: number, height: number): void {
  const size = Math.max(width, height)
  const f = new Float64Array(size)
  const v = new Uint16Array(size)
  const z = new Float64Array(size + 1)
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z)
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z)
}

/**
 * RGBA-маска (фигура — непрозрачные пиксели) → RGBA с полем расстояний в альфе.
 * Размеры маски уже включают запас `SDF_BUFFER`.
 */
export function sdfFromMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const length = width * height
  const outer = new Float64Array(length)
  const inner = new Float64Array(length)
  for (let i = 0; i < length; i++) {
    const a = (mask[i * 4 + 3] as number) / 255
    if (a >= 1) {
      outer[i] = 0
      inner[i] = INF
    } else if (a <= 0) {
      outer[i] = INF
      inner[i] = 0
    } else {
      // Сглаженный край: расстояние до середины пикселя края
      outer[i] = Math.max(0, 0.5 - a) ** 2
      inner[i] = Math.max(0, a - 0.5) ** 2
    }
  }
  edt(outer, width, height)
  edt(inner, width, height)
  const out = new Uint8ClampedArray(length * 4)
  for (let i = 0; i < length; i++) {
    const distance = Math.sqrt(outer[i] as number) - Math.sqrt(inner[i] as number)
    out[i * 4 + 3] = Math.round(255 - 255 * (distance / RADIUS + CUTOFF))
  }
  return out
}
