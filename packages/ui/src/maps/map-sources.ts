/**
 * Источник данных, у которого сменился только адрес тайлов (интервал времени
 * `t`, фильтр карты `f`, версия данных): новый список адресов или null, если
 * изменилось что-то ещё. Такой источник MapLibre перечитывает через `setTiles` —
 * прежние тайлы видны до прихода новых, и анимация времени не мигает.
 */
export function tilesOnlyChange(previous: string | undefined, next: string): string[] | null {
  if (!previous) return null
  let before: Record<string, unknown>
  let after: Record<string, unknown>
  try {
    before = JSON.parse(previous) as Record<string, unknown>
    after = JSON.parse(next) as Record<string, unknown>
  } catch {
    return null
  }
  if (after.type !== 'vector' && after.type !== 'raster') return null
  if (before.type !== after.type) return null
  if (!Array.isArray(before.tiles) || !Array.isArray(after.tiles)) return null
  if (!after.tiles.every((url) => typeof url === 'string')) return null
  const { tiles: _beforeTiles, ...restBefore } = before
  const { tiles, ...restAfter } = after
  if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) return null
  return tiles as string[]
}
