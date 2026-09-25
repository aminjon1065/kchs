import type { MapCamera } from '@kchs/contracts'
import {
  Button,
  Callout,
  type ControlProps,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Input,
  MapCanvas,
  type MapClickEvent,
  type MapLayerSpecification,
  type MapSourceSpecification,
  useMapTheme,
} from '@kchs/ui'
import { LocateFixed, MapPin, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { registerPmtilesProtocol, useBasemapStyle } from '../basemaps.js'
import { locate, locateErrorKey } from './coordinates-dialog.js'
import { type CoordinatesError, parseCoordinates } from './geometry.js'

type LonLat = [number, number]

/** Вся страна: точки ещё нет. */
const COUNTRY: MapCamera = { center: [71, 38.7], zoom: 5.6, bearing: 0, pitch: 0 }
const SOURCE = 'point-pick'
const digits = (value: number) => value.toFixed(5)

/** Точка GeoJSON значения поля; иное — «не указана». */
function lonLatOf(value: unknown): LonLat | null {
  if (!value || typeof value !== 'object') return null
  const point = value as { type?: unknown; coordinates?: unknown }
  if (point.type !== 'Point' || !Array.isArray(point.coordinates)) return null
  const [lon, lat] = point.coordinates
  return typeof lon === 'number' && typeof lat === 'number' ? [lon, lat] : null
}

/**
 * Поле-точка формы сбора и карточки (ADR-0157): координаты подписью кнопки, по нажатию —
 * диалог с картой. Щелчок по карте ставит точку, широту и долготу можно ввести
 * вручную, местоположение устройства подставляется кнопкой.
 */
export function PointField({ id, value, onChange, invalid, disabled }: ControlProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const point = lonLatOf(value)
  return (
    <div className="flex items-center gap-1">
      <Button
        id={id}
        type="button"
        size="sm"
        variant="secondary"
        icon={<MapPin className="size-3.5" />}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen(true)}
      >
        {point ? `${digits(point[1])}, ${digits(point[0])}` : t('gis.point.pick')}
      </Button>
      {point && !disabled ? (
        <IconButton
          type="button"
          size="sm"
          label={t('gis.point.clear')}
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
      {open ? (
        <PointDialog
          point={point}
          onApply={(next) => {
            onChange({ type: 'Point', coordinates: next })
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

function PointDialog({
  point,
  onApply,
  onClose,
}: {
  point: LonLat | null
  onApply: (point: LonLat) => void
  onClose: () => void
}) {
  const t = useT()
  const ids = useId()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, 'muted')
  const [camera, setCamera] = useState<MapCamera>(
    point ? { ...COUNTRY, center: point, zoom: 11 } : COUNTRY,
  )
  const [lat, setLat] = useState(point ? digits(point[1]) : '')
  const [lon, setLon] = useState(point ? digits(point[0]) : '')
  const [error, setError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)

  const parsed = parseCoordinates(`${lat}, ${lon}`)
  const current: LonLat | null =
    Array.isArray(parsed) && parsed[0] ? [parsed[0][0], parsed[0][1]] : null
  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({
      [SOURCE]: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: current
            ? [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: current },
                  properties: {},
                },
              ]
            : [],
        },
      },
    }),
    [current?.[0], current?.[1]],
  )
  const layers = useMemo<MapLayerSpecification[]>(
    () =>
      theme
        ? [
            {
              id: SOURCE,
              type: 'circle',
              source: SOURCE,
              paint: {
                'circle-radius': 7,
                'circle-color': theme.tokens.accent,
                'circle-stroke-color': theme.surface,
                'circle-stroke-width': 2,
              },
            },
          ]
        : [],
    [theme],
  )

  const place = ([nextLon, nextLat]: LonLat) => {
    setLon(digits(nextLon))
    setLat(digits(nextLat))
    setError(null)
  }
  const fillLocation = async () => {
    setLocating(true)
    setError(null)
    try {
      const found = await locate()
      place([found.lon, found.lat])
      setCamera((view) => ({ ...view, center: [found.lon, found.lat], zoom: 13 }))
    } catch (failure) {
      setError(t(locateErrorKey(failure)))
    } finally {
      setLocating(false)
    }
  }
  const apply = () => {
    if (!Array.isArray(parsed)) {
      const problem = parsed as CoordinatesError
      setError(
        problem.reason === 'count'
          ? t('gis.edit.coordinates.count.point')
          : t(`gis.edit.coordinates.errors.${problem.reason}`, { line: 1 }),
      )
      return
    }
    if (current) onApply(current)
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('gis.point.title')}
        description={t('gis.point.hint')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" onClick={apply}>
              {t('gis.edit.coordinates.apply')}
            </Button>
          </>
        }
      >
        <div ref={setRoot} className="flex flex-col gap-3">
          <MapCanvas
            className="h-80 rounded-md"
            basemapStyle={basemap.style}
            prepare={registerPmtilesProtocol}
            sources={sources}
            layers={layers}
            camera={camera}
            onCameraChange={setCamera}
            onFeatureClick={(event: MapClickEvent) => place(event.lngLat)}
            aria-label={t('gis.point.map')}
          />
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
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={<LocateFixed className="size-3.5" />}
              loading={locating}
              onClick={() => void fillLocation()}
            >
              {t('gis.edit.gps.here')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
