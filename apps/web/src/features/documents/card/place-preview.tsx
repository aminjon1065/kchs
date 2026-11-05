import { Suspense } from 'react'
import { LazyPointMap } from '~/features/gis/index.js'

/** Точка GeoJSON значения поля «геометрия» — `[долгота, широта]` или `null`. */
export function pointOf(value: unknown): readonly [number, number] | null {
  if (!value || typeof value !== 'object') return null
  const geometry = value as { type?: unknown; coordinates?: unknown }
  if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null
  const [lon, lat] = geometry.coordinates as unknown[]
  return typeof lon === 'number' && typeof lat === 'number' ? [lon, lat] : null
}

/**
 * Превью места документа (ADR-0230): точка на подложке модуля ГИС — ленивый компонент,
 * в чанк карточки попадает только ссылка на загрузку. Не точка — ничего.
 */
export function PlacePreview({ value, height = 140 }: { value: unknown; height?: number }) {
  const point = pointOf(value)
  if (!point) return null
  return (
    <Suspense fallback={null}>
      <LazyPointMap
        point={point}
        height={height}
        className="overflow-hidden rounded-md border border-line"
      />
    </Suspense>
  )
}
