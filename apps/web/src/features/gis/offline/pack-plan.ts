/**
 * Расчёт подложки района на устройстве (ADR-0211): какие тайлы архива PMTiles
 * покрывают рамку района на каждом масштабе, до какого масштаба хватает бюджета и
 * какими диапазонами байтов их забрать. Чистые функции — без сети и хранилища.
 */

/** Рамка района: запад, юг, восток, север (WGS 84). */
export type Bbox = [number, number, number, number]

/** Диапазон байтов архива: смещение и длина. */
export type ByteRange = [number, number]

/** Больше тайлов на архив район не берёт: десятки мегабайт и минуты загрузки. */
export const MAX_PACK_TILES = 40_000
/** Соседние диапазоны склеиваются, если между ними не больше 32 КБ… */
const MERGE_GAP = 32 * 1024
/** …и склейка не длиннее 4 МБ: один запрос — один кусок в хранилище. */
const MAX_CHUNK = 4 * 1024 * 1024

const MAX_LAT = 85.0511287798

/** Номер тайла по долготе и широте на масштабе `z` (схема XYZ). */
export function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const rad = (clampedLat * Math.PI) / 180
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  const clamp = (value: number) => Math.max(0, Math.min(n - 1, value))
  return [clamp(x), clamp(y)]
}

/** Прямоугольник тайлов рамки на масштабе `z`: x и y от и до включительно. */
export function tileRange(
  bbox: Bbox,
  z: number,
): { x0: number; x1: number; y0: number; y1: number } {
  const [west, south, east, north] = bbox
  const [x0, y0] = tileOf(west, north, z)
  const [x1, y1] = tileOf(east, south, z)
  return { x0, x1, y0, y1 }
}

export function tileCount(bbox: Bbox, z: number): number {
  const range = tileRange(bbox, z)
  return (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1)
}

/**
 * Наибольший масштаб, на котором рамка укладывается в бюджет тайлов (сумма по всем
 * масштабам от `minZoom`). Мельче `minZoom` архив не хранит; крупнее `maxZoom` — тоже,
 * дальше карта растягивает тайлы сама.
 */
export function fitMaxZoom(
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
  budget = MAX_PACK_TILES,
): number {
  let total = 0
  let best = minZoom
  for (let z = minZoom; z <= maxZoom; z += 1) {
    total += tileCount(bbox, z)
    if (total > budget) break
    best = z
  }
  return best
}

/** Тайлы рамки от `minZoom` до `maxZoom` по порядку масштабов. */
export function* tilesOf(
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
): Generator<[number, number, number]> {
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const { x0, x1, y0, y1 } = tileRange(bbox, z)
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) yield [z, x, y]
    }
  }
}

/**
 * Склейка диапазонов: без повторов, по порядку смещений, соседние — через небольшой
 * зазор в один кусок. Тайлы архива лежат по кривой Гильберта, и тайлы района
 * идут длинными сериями — сотни запросов вместо десятков тысяч.
 */
export function mergeRanges(
  ranges: Iterable<ByteRange>,
  gap = MERGE_GAP,
  maxChunk = MAX_CHUNK,
): ByteRange[] {
  const sorted = [...ranges].filter(([, length]) => length > 0).sort((a, b) => a[0] - b[0])
  const merged: ByteRange[] = []
  for (const [offset, length] of sorted) {
    const last = merged.at(-1)
    if (last) {
      const lastEnd = last[0] + last[1]
      const end = offset + length
      if (offset <= lastEnd + gap && Math.max(lastEnd, end) - last[0] <= maxChunk) {
        last[1] = Math.max(lastEnd, end) - last[0]
        continue
      }
      // Пересечение, а склейка вышла бы длиннее куска: диапазон — своим куском целиком
      // (куски могут перекрываться — `findChunk` это учитывает)
      if (offset < lastEnd && end <= lastEnd) continue
    }
    merged.push([offset, length])
  }
  return merged
}

/**
 * Кусок, целиком покрывающий диапазон, — двоичным поиском по отсортированным кускам.
 * Возвращает индекс куска или -1.
 */
export function findChunk(chunks: readonly ByteRange[], offset: number, length: number): number {
  // Последний кусок, который начинается не позже диапазона
  let low = 0
  let high = chunks.length - 1
  let last = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((chunks[middle] as ByteRange)[0] <= offset) {
      last = middle
      low = middle + 1
    } else high = middle - 1
  }
  // Перекрытые куски редки: проверить ещё пару предыдущих
  for (let index = last; index >= 0 && index >= last - 2; index -= 1) {
    const [start, size] = chunks[index] as ByteRange
    if (offset + length <= start + size) return index
  }
  return -1
}

export function totalBytes(chunks: readonly ByteRange[]): number {
  return chunks.reduce((sum, [, length]) => sum + length, 0)
}
