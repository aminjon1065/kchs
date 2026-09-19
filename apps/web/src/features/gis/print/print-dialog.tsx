import type { MapCamera } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  type MapInstance,
  type MapSnapshot,
  SegmentedControl,
  Spinner,
  snapshotMap,
  useDebouncedValue,
  useMapTheme,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Download, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { meQuery } from '~/shared/api/queries.js'
import type { PanelLayer } from '../layer-panel.js'
import { useRenderedLayers } from '../layer-render.js'
import { pdfWithImage } from './pdf.js'
import {
  legendRows,
  type PrintFormat,
  type PrintOptions,
  type PrintOrientation,
  paperPoints,
  printFileName,
  printLayout,
} from './print-layout.js'
import { composePrint, loadLegendIcons, type PrintFont, type PrintPalette } from './print-render.js'

/** Превью листа в диалоге — уменьшенная копия, лист целиком строится при выгрузке. */
const PREVIEW_WIDTH = 720

/** Цвета и шрифт листа — светлая тема дизайн-системы: печать на белом. */
async function printTheme(): Promise<{ palette: PrintPalette; font: PrintFont }> {
  const { default: tokens } = await import('@kchs/ui/tokens.json')
  const n = tokens.color.neutral
  const family = tokens.typography.fontFamily.sans
  // Шрифт интерфейса — до рисования: холст не ждёт загрузки @font-face
  await Promise.all(
    ['400 10px', '500 10px', '600 18px', 'italic 400 10px'].map((font) =>
      document.fonts.load(`${font} ${family}`).catch(() => []),
    ),
  )
  return {
    palette: {
      text: n.text.light,
      secondary: n['text-secondary'].light,
      muted: n['text-muted'].light,
      border: n['border-strong'].light,
      surface: n['bg-surface'].light,
    },
    font: { family },
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas'))), type, quality),
  )

/**
 * Вид кадра печати: «текущий вид» — как на экране; лист — тот же центр и
 * поворот, масштаб такой, чтобы видимая на экране область поместилась в кадр.
 */
function frameCamera(
  map: MapInstance,
  frame: { w: number; h: number },
  view: { width: number; height: number },
  format: PrintFormat,
): MapCamera {
  const center = map.getCenter()
  const zoom =
    format === 'view'
      ? map.getZoom()
      : map.getZoom() + Math.log2(Math.min(frame.w / view.width, frame.h / view.height))
  return {
    center: [center.lng, center.lat],
    zoom: Math.min(22, Math.max(0, zoom)),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  }
}

/**
 * Печать и выгрузка карты (07-gis-engine.md §13, P2-E02 S06, ADR-0074): лист
 * A4/A3 или текущий вид — заголовок, кадр карты (снимок `snapshotMap` без
 * чтения экранного холста), легенда видимых слоёв, масштаб, север, атрибуция
 * источников (OpenStreetMap — всегда), дата и автор. PNG или PDF собираются в
 * браузере: сервер печати (Playwright) — для отчётов по расписанию.
 */
export function PrintDialog({
  map,
  name,
  layers,
  onClose,
}: {
  map: MapInstance
  name: string
  layers: readonly PanelLayer[]
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const [options, setOptions] = useState<PrintOptions>({
    format: 'view',
    orientation: 'landscape',
    title: name,
    legend: true,
    scaleBar: true,
    north: true,
    signature: true,
  })
  const title = useDebouncedValue(options.title, 300)
  const [snapshot, setSnapshot] = useState<{ key: string; value: MapSnapshot } | null>(null)
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState<'png' | 'pdf' | null>(null)
  const composed = useRef<HTMLCanvasElement | null>(null)

  // Легенды видимых слоёв — те же, что в панели слоёв (цвета текущей темы карты)
  const entries = layers.flatMap(({ entry, layer }) =>
    layer && entry.visible && layer.dataAccess
      ? [{ layer, visible: true, opacity: entry.opacity }]
      : [],
  )
  const rendered = useRenderedLayers(entries, theme)
  const legendKey = entries.map((entry) => entry.layer.id).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: легенды — по составу слоёв и компиляции
  const rows = useMemo(
    () =>
      legendRows(
        entries.flatMap(({ layer }) => {
          const legend = rendered.legends.get(layer.id)
          return legend ? [{ name: layer.name, legend }] : []
        }),
      ),
    [legendKey, rendered],
  )

  const container = map.getContainer()
  const view = { width: container.clientWidth, height: container.clientHeight }
  const layout = printLayout({ options: { ...options, title }, view, rows })
  const frameKey = `${options.format}:${options.orientation}:${Math.round(layout.map.w)}x${Math.round(layout.map.h)}:${layout.unit}`

  // Снимок кадра — заново только при смене размера кадра (формат, ориентация, легенда)
  // biome-ignore lint/correctness/useExhaustiveDependencies: кадр задаёт ключ
  useEffect(() => {
    if (snapshot?.key === frameKey) return
    let cancelled = false
    setFailed(false)
    setPreview(null)
    snapshotMap(map, {
      width: layout.map.w,
      height: layout.map.h,
      pixelRatio: layout.unit,
      camera: frameCamera(map, layout.map, view, options.format),
    })
      .then((value) => {
        if (!cancelled) setSnapshot({ key: frameKey, value })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [frameKey])

  // Лист — из снимка: подписи, легенда и подвал перерисовываются без нового снимка
  // biome-ignore lint/correctness/useExhaustiveDependencies: лист — по снимку и настройкам
  useEffect(() => {
    if (!snapshot || snapshot.key !== frameKey) return
    let cancelled = false
    const run = async () => {
      const [{ palette, font }, icons] = await Promise.all([
        printTheme(),
        loadLegendIcons(options.legend ? rows : []),
      ])
      if (cancelled) return
      const sources = [...snapshot.value.attribution]
      if (!sources.some((text) => /openstreetmap/i.test(text))) sources.push(t('gis.print.osm'))
      const number = (value: number) => new Intl.NumberFormat(locale).format(value)
      const canvas = composePrint({
        layout,
        options: { ...options, title },
        snapshot: snapshot.value,
        rows: options.legend ? rows : [],
        palette,
        font,
        icons,
        texts: {
          title,
          signature: [
            formatDate(new Date(), { locale, timezone: me?.user.timezone }),
            me?.user.displayName,
          ]
            .filter(Boolean)
            .join(' · '),
          attribution: sources.join(' · '),
          more: (count) => t('gis.print.more', { count }),
          distance: (meters) =>
            meters >= 1000
              ? t('gis.print.kilometers', { value: number(meters / 1000) })
              : t('gis.print.meters', { value: number(meters) }),
          north: t('gis.print.north'),
        },
      })
      composed.current = canvas
      const scale = Math.min(1, PREVIEW_WIDTH / canvas.width)
      const small = document.createElement('canvas')
      small.width = Math.round(canvas.width * scale)
      small.height = Math.round(canvas.height * scale)
      small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height)
      setPreview(small.toDataURL('image/png'))
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [
    snapshot,
    frameKey,
    title,
    options.legend,
    options.scaleBar,
    options.north,
    options.signature,
    rows,
    locale,
    me,
  ])

  const save = async (kind: 'png' | 'pdf') => {
    const canvas = composed.current
    if (!canvas) return
    setSaving(kind)
    try {
      if (kind === 'png') {
        download(await toBlob(canvas, 'image/png'), printFileName(title, 'png'))
        return
      }
      const format = options.format === 'view' ? 'a4' : options.format
      const page =
        options.format === 'view'
          ? ([(canvas.width / layout.unit) * 0.75, (canvas.height / layout.unit) * 0.75] as const)
          : paperPoints(format, options.orientation)
      const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer())
      const pdf = pdfWithImage({ jpeg, width: canvas.width, height: canvas.height, page, title })
      download(new Blob([pdf], { type: 'application/pdf' }), printFileName(title, 'pdf'))
    } finally {
      setSaving(null)
    }
  }

  const set = <K extends keyof PrintOptions>(key: K, value: PrintOptions[K]) =>
    setOptions((current) => ({ ...current, [key]: value }))
  const ready = Boolean(preview)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.print.title')}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant={options.format === 'view' ? 'secondary' : 'primary'}
              icon={<FileText className="size-3.5" />}
              disabled={!ready}
              loading={saving === 'pdf'}
              onClick={() => void save('pdf')}
            >
              {t('gis.print.pdf')}
            </Button>
            <Button
              variant={options.format === 'view' ? 'primary' : 'secondary'}
              icon={<Download className="size-3.5" />}
              disabled={!ready}
              loading={saving === 'png'}
              onClick={() => void save('png')}
            >
              {t('gis.print.png')}
            </Button>
          </>
        }
      >
        <div ref={setRoot} className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            <Field label={t('gis.print.heading')}>
              <Input
                value={options.title}
                maxLength={200}
                onChange={(event) => set('title', event.target.value)}
                aria-label={t('gis.print.heading')}
              />
            </Field>
            <Field label={t('gis.print.format')}>
              <SegmentedControl
                aria-label={t('gis.print.format')}
                size="sm"
                value={options.format}
                onValueChange={(format: PrintFormat) => set('format', format)}
                options={(['view', 'a4', 'a3'] as const).map((value) => ({
                  value,
                  label: t(`gis.print.formats.${value}`),
                }))}
              />
            </Field>
            {options.format === 'view' ? null : (
              <Field label={t('gis.print.orientation')}>
                <SegmentedControl
                  aria-label={t('gis.print.orientation')}
                  size="sm"
                  value={options.orientation}
                  onValueChange={(orientation: PrintOrientation) => set('orientation', orientation)}
                  options={(['landscape', 'portrait'] as const).map((value) => ({
                    value,
                    label: t(`gis.print.orientations.${value}`),
                  }))}
                />
              </Field>
            )}
            <div className="flex flex-col gap-2">
              <Checkbox
                label={t('gis.print.legend')}
                checked={options.legend}
                onCheckedChange={(checked) => set('legend', checked === true)}
              />
              <Checkbox
                label={t('gis.print.scale')}
                checked={options.scaleBar}
                onCheckedChange={(checked) => set('scaleBar', checked === true)}
              />
              <Checkbox
                label={t('gis.print.northArrow')}
                checked={options.north}
                onCheckedChange={(checked) => set('north', checked === true)}
              />
              <Checkbox
                label={t('gis.print.signature')}
                checked={options.signature}
                onCheckedChange={(checked) => set('signature', checked === true)}
              />
            </div>
            <p className="text-2xs text-fg-muted">{t('gis.print.attributionHint')}</p>
            {snapshot && !snapshot.value.complete ? (
              <Callout tone="warning">{t('gis.print.incomplete')}</Callout>
            ) : null}
          </div>
          <div className="flex min-h-[280px] items-center justify-center rounded-md border border-line bg-surface-2 p-3">
            {failed ? (
              <Callout tone="danger">{t('gis.print.failed')}</Callout>
            ) : preview ? (
              <img
                src={preview}
                alt={t('gis.print.preview')}
                className="max-h-[440px] max-w-full border border-line bg-surface shadow-sm"
              />
            ) : (
              <Spinner label={t('gis.print.preparing')} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
