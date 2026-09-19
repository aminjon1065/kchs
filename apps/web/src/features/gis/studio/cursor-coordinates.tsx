import { formatNumber } from '@kchs/fields'
import { useLocalStorage } from '@kchs/ui'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useStudio } from './context.js'
import {
  formatDecimal,
  formatDms,
  type LonLat,
  roundScale,
  scaleDenominator,
} from './coordinates.js'

type Format = 'decimal' | 'dms'

/**
 * Координаты под курсором и численный масштаб (P2-E02 S02, 03-screens.md §10):
 * в правом нижнем углу карты. Без курсора над картой — центр вида. Щелчок —
 * другой формат (десятичные градусы ↔ градусы-минуты-секунды), выбор помнится.
 */
export function CursorCoordinates() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { map, camera } = useStudio()
  const [cursor, setCursor] = useState<LonLat | null>(null)
  const [format, setFormat] = useLocalStorage<Format>('kchs.map.coordinates', 'decimal')

  useEffect(() => {
    if (!map) return
    let frame = 0
    let pending: LonLat | null = null
    const onMove = (event: { lngLat: { lng: number; lat: number } }) => {
      pending = { lon: event.lngLat.lng, lat: event.lngLat.lat }
      if (frame) return
      // Не чаще кадра: курсор двигается быстрее, чем нужно перерисовывать строку
      frame = requestAnimationFrame(() => {
        frame = 0
        setCursor(pending)
      })
    }
    const onOut = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      setCursor(null)
    }
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
    }
  }, [map])

  if (!map) return null
  const point = cursor ?? { lon: camera.center[0], lat: camera.center[1] }
  const labels = {
    n: t('gis.coords.n'),
    s: t('gis.coords.s'),
    e: t('gis.coords.e'),
    w: t('gis.coords.w'),
  }
  const scale = roundScale(scaleDenominator(camera.zoom, camera.center[1]))
  const next: Format = format === 'decimal' ? 'dms' : 'decimal'

  return (
    <div className="pointer-events-none absolute bottom-7 right-2 z-10 flex justify-end">
      <button
        type="button"
        onClick={() => setFormat(next)}
        title={t(`gis.coords.switch.${next}`)}
        aria-label={t('gis.coords.label', {
          coordinates: format === 'dms' ? formatDms(point, labels) : formatDecimal(point),
        })}
        className="pointer-events-auto flex items-center gap-2 rounded-sm border border-line bg-surface/90 px-2 py-0.5 text-xs text-fg-secondary shadow-sm backdrop-blur-sm hover:text-fg"
      >
        <span className="tabular">
          {format === 'dms' ? formatDms(point, labels) : formatDecimal(point)}
        </span>
        {scale > 0 ? (
          <span className="tabular border-l border-line pl-2 text-fg-muted">
            {t('gis.coords.scale', { value: formatNumber(scale, { precision: 0 }, { locale }) })}
          </span>
        ) : null}
      </button>
    </div>
  )
}
