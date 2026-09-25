import type { ReportImage } from '@kchs/contracts'
import {
  type MapCamera,
  REPORT_FIGURE_HEIGHT,
  REPORT_FIGURE_SIZES,
  REPORT_MAX_FILES,
  REPORT_MAX_METRICS,
  REPORT_MAX_TABLE_ROWS,
  type ReportFigureSize,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  IconButton,
  Input,
  MapCanvas,
  MapLegend,
  renderMapIcon,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useMapTheme,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Crosshair, RotateCcw, Scissors, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { metricQuery } from '~/features/data/queries.js'
import { registerPmtilesProtocol } from '~/features/gis/basemaps.js'
import { useNotebook } from '~/features/notebooks/notebook-context.js'
import { type CellMap, useCellValue, writeCell } from '~/features/notebooks/notebook-doc.js'
import { ObjectPicker } from '~/features/notebooks/object-picker.js'
import { QueryCell } from '~/features/notebooks/query-cell.js'
import { ChartCell } from '~/features/notebooks/source-cells.js'
import { http } from '~/shared/api/client.js'
import { useReportMap } from './report-map.js'

const NO_METRICS: string[] = []

/** Высота графика или карты на странице. */
export function SizeControl({ cell }: { cell: CellMap }) {
  const t = useT()
  const { readOnly } = useNotebook()
  const size = useCellValue<ReportFigureSize>(cell, 'size') ?? 'medium'
  return (
    <Select
      value={size}
      disabled={readOnly}
      onValueChange={(next) => writeCell(cell, { size: next })}
    >
      <SelectTrigger aria-label={t('data.report.block.size')} className="h-7 w-40 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {REPORT_FIGURE_SIZES.map((item) => (
          <SelectItem key={item} value={item}>
            {t(`data.report.sizes.${item}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Запрос как в тетради и настройки печати: высота графика, строк таблицы. */
export function QueryBlock({ cell, id }: { cell: CellMap; id: string }) {
  const t = useT()
  const { readOnly } = useNotebook()
  const view = useCellValue<'table' | 'chart'>(cell, 'view') ?? 'table'
  const mode = useCellValue<'visual' | 'sql'>(cell, 'mode') ?? 'visual'
  const maxRows = useCellValue<number>(cell, 'maxRows') ?? 100
  const [rows, setRows] = useState(String(maxRows))
  const table = view === 'table' || mode === 'sql'
  return (
    <div className="flex flex-col gap-3">
      <QueryCell cell={cell} cellId={id} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">
          {t('data.report.block.print')}
        </span>
        {table ? (
          <label className="flex items-center gap-2 text-xs text-fg-secondary">
            {t('data.report.block.maxRows')}
            <Input
              type="number"
              min={1}
              max={REPORT_MAX_TABLE_ROWS}
              value={rows}
              disabled={readOnly}
              className="h-7 w-24"
              onChange={(event) => setRows(event.target.value)}
              onBlur={() => {
                const next = Math.round(Number(rows))
                const clamped = Number.isFinite(next)
                  ? Math.min(REPORT_MAX_TABLE_ROWS, Math.max(1, next))
                  : maxRows
                setRows(String(clamped))
                if (clamped !== maxRows) writeCell(cell, { maxRows: clamped })
              }}
            />
          </label>
        ) : (
          <SizeControl cell={cell} />
        )}
      </div>
    </div>
  )
}

/** Сохранённый график как в тетради: графиком или таблицей его данных. */
export function ChartBlock({ cell, id }: { cell: CellMap; id: string }) {
  const t = useT()
  const { readOnly } = useNotebook()
  const view = useCellValue<'chart' | 'table'>(cell, 'view') ?? 'chart'
  return (
    <div className="flex flex-col gap-3">
      <ChartCell cell={cell} cellId={id} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">
          {t('data.report.block.print')}
        </span>
        <SegmentedControl
          size="sm"
          aria-label={t('data.report.block.chartView')}
          value={view}
          onValueChange={(next) => !readOnly && writeCell(cell, { view: next })}
          options={[
            { value: 'chart', label: t('data.report.block.asChart') },
            { value: 'table', label: t('data.report.block.asTable') },
          ]}
        />
        {view === 'chart' ? <SizeControl cell={cell} /> : null}
      </div>
    </div>
  )
}

function MetricName({ id }: { id: string }) {
  const { data } = useQuery({ ...metricQuery(id), retry: false })
  return <span className="truncate">{data?.name ?? '…'}</span>
}

/**
 * Сетка показателей: до 12 показателей, период отчёта заменяет их период;
 * значения — на странице печати, с правами того, под кем строится отчёт.
 */
export function MetricsBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { spaceId, readOnly } = useNotebook()
  const metricIds = useCellValue<string[]>(cell, 'metricIds') ?? NO_METRICS
  return (
    <div className="flex flex-col gap-3">
      {metricIds.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('data.report.block.metrics')}>
          {metricIds.map((id) => (
            <li
              key={id}
              className="flex max-w-64 items-center gap-1 rounded-sm border border-line bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs"
            >
              <MetricName id={id} />
              {readOnly ? null : (
                <IconButton
                  label={t('data.report.block.removeMetric')}
                  size="sm"
                  onClick={() =>
                    writeCell(cell, { metricIds: metricIds.filter((item) => item !== id) })
                  }
                >
                  <X className="size-3" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-muted">
          {t('data.report.block.pickMetrics')}
        </p>
      )}
      {readOnly || metricIds.length >= REPORT_MAX_METRICS ? null : (
        <ObjectPicker
          type="metric"
          value={null}
          spaceId={spaceId}
          label={t('data.report.block.addMetric')}
          placeholder={t('data.report.block.addMetric')}
          onChange={(id) => {
            if (!metricIds.includes(id)) writeCell(cell, { metricIds: [...metricIds, id] })
          }}
        />
      )}
      <p className="text-2xs text-fg-muted">{t('data.report.block.metricsHint')}</p>
    </div>
  )
}

/**
 * Карта: сохранённая карта или слой; вид блока фиксируется с предпросмотра
 * («Зафиксировать вид»), иначе — вид карты или охват данных слоя.
 */
export function MapBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { spaceId, readOnly } = useNotebook()
  const source = useCellValue<'map' | 'layer'>(cell, 'source') ?? 'map'
  const mapId = useCellValue<string | null>(cell, 'mapId') ?? null
  const layerId = useCellValue<string | null>(cell, 'layerId') ?? null
  const camera = useCellValue<MapCamera | null>(cell, 'camera') ?? null
  const size = useCellValue<ReportFigureSize>(cell, 'size') ?? 'large'
  const legend = useCellValue<boolean>(cell, 'legend') ?? true
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const state = useReportMap({ source, mapId, layerId, camera }, theme)
  const [view, setView] = useState<MapCamera | null>(null)
  const fit = useMemo(() => (state.fit ? { bbox: state.fit, key: 'fit' } : null), [state.fit])

  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          aria-label={t('data.report.block.mapSource')}
          value={source}
          onValueChange={(next) => !readOnly && writeCell(cell, { source: next, camera: null })}
          options={[
            { value: 'map', label: t('objects.types.map') },
            { value: 'layer', label: t('objects.types.layer') },
          ]}
        />
        <ObjectPicker
          type={source}
          value={source === 'map' ? mapId : layerId}
          spaceId={spaceId}
          disabled={readOnly}
          label={t(source === 'map' ? 'data.report.block.pickMap' : 'data.report.block.pickLayer')}
          placeholder={t(
            source === 'map' ? 'data.report.block.pickMap' : 'data.report.block.pickLayer',
          )}
          onChange={(id) =>
            writeCell(
              cell,
              source === 'map' ? { mapId: id, camera: null } : { layerId: id, camera: null },
            )
          }
        />
        <SizeControl cell={cell} />
        <Switch
          checked={legend}
          disabled={readOnly}
          onCheckedChange={(next) => writeCell(cell, { legend: next })}
          label={t('data.report.block.legend')}
        />
      </div>
      {state.missing ? (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-muted">
          {t(source === 'map' ? 'data.report.block.pickMap' : 'data.report.block.pickLayer')}
        </p>
      ) : state.denied ? (
        <Callout tone="warning" title={t('data.notebook.noAccess')} />
      ) : (
        <>
          <div
            className="relative w-full overflow-hidden rounded-md border border-line"
            style={{ height: REPORT_FIGURE_HEIGHT[size] }}
          >
            {state.loading ? null : (
              <MapCanvas
                className="absolute inset-0"
                basemapStyle={state.basemapStyle}
                prepare={registerPmtilesProtocol}
                sources={state.rendered.sources}
                layers={state.rendered.layers}
                images={state.rendered.images}
                camera={state.camera}
                fitBounds={fit}
                staticView
                onCameraChange={setView}
                aria-label={t('data.report.kinds.map')}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Crosshair className="size-3.5" />}
              disabled={readOnly || !view}
              onClick={() => view && writeCell(cell, { camera: view })}
            >
              {t('data.report.block.fixView')}
            </Button>
            {camera ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                disabled={readOnly}
                onClick={() => writeCell(cell, { camera: null })}
              >
                {t('data.report.block.resetView')}
              </Button>
            ) : null}
            <span className="text-2xs text-fg-muted">
              {camera ? t('data.report.block.viewFixed') : t('data.report.block.viewAuto')}
            </span>
          </div>
          {legend && state.legends.length > 0 ? (
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {state.legends.map((item, index) => (
                // Легенды слоёв неизменяемы и без идентификаторов — индекс устойчив
                <MapLegend key={index} legend={item} renderIcon={renderMapIcon} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Разрыв страницы: дальше — с новой страницы PDF и DOCX. */
export function PageBreakBlock() {
  const t = useT()
  return (
    <div className="flex items-center gap-3 text-2xs text-fg-muted">
      <hr className="m-0 flex-1 border-0 border-t border-dashed border-line-strong" />
      <span className="flex items-center gap-1">
        <Scissors className="size-3.5" aria-hidden />
        {t('data.report.block.pageBreak')}
      </span>
      <hr className="m-0 flex-1 border-0 border-t border-dashed border-line-strong" />
    </div>
  )
}

const NO_FILES: string[] = []

/**
 * Изображение (ADR-0164): файл-картинка из файлов платформы, подпись — подпись блока. Файл с
 * грифом в отчёт не печатается — сервер отказывает, в блоке видна причина.
 */
export function ImageBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { notebookId, spaceId, readOnly } = useNotebook()
  const fileId = useCellValue<string | null>(cell, 'fileId') ?? null
  const size = useCellValue<ReportFigureSize>(cell, 'size') ?? 'medium'
  const image = useQuery({
    queryKey: ['report', notebookId, 'image', fileId],
    queryFn: () => http.get<ReportImage>(`/reports/${notebookId}/images/${fileId}`),
    enabled: Boolean(fileId),
    staleTime: 300_000,
    retry: false,
  })
  return (
    <div className="flex flex-col gap-3">
      {fileId && image.data ? (
        <img
          src={image.data.dataUrl}
          alt={image.data.name}
          className="mx-auto max-w-full object-contain"
          style={{ maxHeight: REPORT_FIGURE_HEIGHT[size] }}
        />
      ) : fileId && image.error ? (
        <Callout tone="warning">{(image.error as Error).message}</Callout>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-muted">
          {t('data.report.block.pickImage')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <ObjectPicker
          type="file"
          value={fileId}
          spaceId={spaceId}
          disabled={readOnly}
          label={t('data.report.block.image')}
          placeholder={t('data.report.block.pickImage')}
          onChange={(id) => writeCell(cell, { fileId: id })}
        />
        <SizeControl cell={cell} />
      </div>
    </div>
  )
}

/** Файлы (ADR-0164): приложения к отчёту — названия со ссылками на странице и в DOCX. */
export function FileBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { notebookId, spaceId, readOnly } = useNotebook()
  const fileIds = useCellValue<string[]>(cell, 'fileIds') ?? NO_FILES
  const { data } = useQuery({
    queryKey: ['report', notebookId, 'files', fileIds],
    queryFn: () =>
      http.get<{ items: Array<{ id: string; name: string }> }>(`/reports/${notebookId}/files`, {
        query: { ids: fileIds.join(',') },
      }),
    enabled: fileIds.length > 0,
  })
  const names = new Map((data?.items ?? []).map((item) => [item.id, item.name]))
  return (
    <div className="flex flex-col gap-3">
      {fileIds.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={t('data.report.kinds.file')}>
          {fileIds.map((id) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              <span className="truncate">{names.get(id) ?? t('data.report.block.fileHidden')}</span>
              {readOnly ? null : (
                <IconButton
                  label={t('data.report.block.removeFile')}
                  size="sm"
                  onClick={() =>
                    writeCell(cell, { fileIds: fileIds.filter((item) => item !== id) })
                  }
                >
                  <X className="size-3" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-muted">
          {t('data.report.block.pickFiles')}
        </p>
      )}
      {readOnly || fileIds.length >= REPORT_MAX_FILES ? null : (
        <ObjectPicker
          type="file"
          value={null}
          spaceId={spaceId}
          label={t('data.report.block.addFile')}
          placeholder={t('data.report.block.addFile')}
          onChange={(id) => {
            if (!fileIds.includes(id)) writeCell(cell, { fileIds: [...fileIds, id] })
          }}
        />
      )}
    </div>
  )
}

/**
 * Дашборд (ADR-0164): графики и показатели дашборда с параметрами отчёта — сеткой на
 * странице печати; в редакторе — выбор дашборда и высота.
 */
export function DashboardBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { spaceId, readOnly } = useNotebook()
  const dashboardId = useCellValue<string | null>(cell, 'dashboardId') ?? null
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">{t('data.report.block.dashboardHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <ObjectPicker
          type="dashboard"
          value={dashboardId}
          spaceId={spaceId}
          disabled={readOnly}
          label={t('data.report.kinds.dashboard')}
          placeholder={t('data.report.block.pickDashboard')}
          onChange={(id) => writeCell(cell, { dashboardId: id })}
        />
        <SizeControl cell={cell} />
      </div>
    </div>
  )
}
