import { IconButton } from '@kchs/ui'
import { X } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from 'react'
import { useT } from '~/app/i18n.js'

/** Шаг шторки с клавиатуры, % ширины карты. */
const STEP = 5

const clamp = (value: number) => Math.min(100, Math.max(0, value))

/**
 * Шторка сравнения слоёв (ADR-0160): поверх карты — вторая карта с тем же видом и
 * слоем сравнения, видна справа от шторки; слева — основная карта без него.
 * Верхняя карта не ловит мышь (жесты — основной карты), шторку двигают мышью,
 * пальцем или стрелками.
 */
export function SwipeCompare({
  position,
  layerName,
  onPosition,
  onClose,
  children,
}: {
  position: number
  layerName: string
  onPosition: (position: number) => void
  onClose: () => void
  /** Верхняя карта — со слоем сравнения. */
  children: ReactNode
}) {
  const t = useT()
  const area = useRef<HTMLDivElement>(null)

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (clientX: number) => onPosition(clamp(((clientX - box.left) / box.width) * 100))
    move(event.clientX)
    const target = event.currentTarget
    const onMove = (next: globalThis.PointerEvent) => move(next.clientX)
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? -STEP : event.key === 'ArrowRight' ? STEP : null
    if (delta === null) return
    event.preventDefault()
    onPosition(clamp(position + delta))
  }

  return (
    <div ref={area} className="pointer-events-none absolute inset-0 z-[5]">
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
        {children}
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('gis.map.swipe.handle', { name: layerName })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-orientation="horizontal"
        onPointerDown={drag}
        onKeyDown={keys}
        className="pointer-events-auto absolute inset-y-0 -ml-1.5 flex w-3 cursor-ew-resize touch-none justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ left: `${position}%` }}
      >
        <span className="h-full w-0.5 bg-accent shadow-sm" />
      </div>
      <div className="pointer-events-auto absolute right-2 bottom-10 flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-secondary shadow-sm">
        <span className="max-w-60 truncate">{t('gis.map.swipe.right', { name: layerName })}</span>
        <IconButton size="sm" label={t('gis.map.swipe.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
    </div>
  )
}
