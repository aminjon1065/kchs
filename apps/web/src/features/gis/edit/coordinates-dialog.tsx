import type { FeatureGeometry } from '@kchs/contracts'
import { Button, Callout, Dialog, DialogContent, Field, Input, Textarea } from '@kchs/ui'
import { LocateFixed } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import {
  buildGeometry,
  type CoordinatesError,
  type DrawKind,
  editablePositions,
  formatCoordinates,
  parseCoordinates,
} from './geometry.js'

/** Местоположение устройства (GPS в мобильном вебе, сеть — на компьютере). */
export interface Located {
  lon: number
  lat: number
  /** Точность, м. */
  accuracy: number
}

export function locate(): Promise<Located> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lon: position.coords.longitude,
          lat: position.coords.latitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => reject(new Error(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    )
  })
}

/** Сообщение об ошибке местоположения — ключ словаря по причине. */
export const locateErrorKey = (error: unknown) =>
  error instanceof Error && error.message === 'denied'
    ? 'gis.edit.gps.denied'
    : error instanceof Error && error.message === 'unavailable'
      ? 'gis.edit.gps.unavailable'
      : 'gis.edit.gps.failed'

const isError = (value: unknown): value is CoordinatesError =>
  typeof value === 'object' && value !== null && 'reason' in value

/**
 * Координаты вручную (07-gis-engine.md §7): точка — широта и долгота, линия и
 * полигон — вершины по строке «широта, долгота»; местоположение устройства
 * дописывается кнопкой. Существующий объект открывается со своими вершинами.
 */
export function CoordinatesDialog({
  kind,
  geometry,
  onApply,
  onClose,
}: {
  kind: DrawKind
  geometry: FeatureGeometry | null
  onApply: (geometry: FeatureGeometry) => void
  onClose: () => void
}) {
  const t = useT()
  const ids = useId()
  const positions = editablePositions(geometry)
  const [text, setText] = useState(() => formatCoordinates(positions ?? []))
  const [lat, setLat] = useState(() =>
    kind === 'point' && positions?.[0] ? String(positions[0][1]) : '',
  )
  const [lon, setLon] = useState(() =>
    kind === 'point' && positions?.[0] ? String(positions[0][0]) : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)

  const errorText = (problem: CoordinatesError) =>
    problem.reason === 'count'
      ? t(`gis.edit.coordinates.count.${kind}`)
      : t(`gis.edit.coordinates.errors.${problem.reason}`, { line: problem.line })

  const fillLocation = async () => {
    setLocating(true)
    setError(null)
    try {
      const place = await locate()
      if (kind === 'point') {
        setLat(place.lat.toFixed(7))
        setLon(place.lon.toFixed(7))
      } else {
        setText((current) =>
          [current.trim(), formatCoordinates([[place.lon, place.lat]])].filter(Boolean).join('\n'),
        )
      }
    } catch (failure) {
      setError(t(locateErrorKey(failure)))
    } finally {
      setLocating(false)
    }
  }

  const apply = () => {
    const parsed = kind === 'point' ? parseCoordinates(`${lat}, ${lon}`) : parseCoordinates(text)
    if (isError(parsed)) {
      setError(errorText(kind === 'point' ? { ...parsed, line: 1 } : parsed))
      return
    }
    const built = buildGeometry(kind, parsed)
    if (isError(built)) {
      setError(errorText(built))
      return
    }
    onApply(built)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.edit.coordinates.title')}
        description={t(`gis.edit.coordinates.hint.${kind}`)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" onClick={apply} disabled={positions === null}>
              {t('gis.edit.coordinates.apply')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {positions === null ? (
            <Callout tone="info">{t('gis.edit.coordinates.complex')}</Callout>
          ) : kind === 'point' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('gis.edit.coordinates.lat')} htmlFor={`${ids}-lat`}>
                <Input
                  id={`${ids}-lat`}
                  inputMode="decimal"
                  value={lat}
                  mono
                  onChange={(event) => setLat(event.target.value)}
                />
              </Field>
              <Field label={t('gis.edit.coordinates.lon')} htmlFor={`${ids}-lon`}>
                <Input
                  id={`${ids}-lon`}
                  inputMode="decimal"
                  value={lon}
                  mono
                  onChange={(event) => setLon(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label={t('gis.edit.coordinates.vertices')} htmlFor={`${ids}-text`}>
              <Textarea
                id={`${ids}-text`}
                rows={8}
                value={text}
                className="font-mono"
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
          )}
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {positions === null ? null : (
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<LocateFixed className="size-3.5" />}
                loading={locating}
                onClick={() => void fillLocation()}
              >
                {kind === 'point' ? t('gis.edit.gps.here') : t('gis.edit.gps.append')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
