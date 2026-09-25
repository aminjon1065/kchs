import {
  type DashboardData,
  type DashboardRecord,
  REPORT_FIGURE_HEIGHT,
  type ReportBlock,
  type ReportImage,
  type ReportPrintBlock,
} from '@kchs/contracts'
import { Chart, NumberTile } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useT } from '~/app/i18n.js'
import { metricTileModel } from '~/features/data/metric-format.js'
import { ApiError, http } from '~/shared/api/client.js'
import { usePrint, useReportReady } from './print-context.js'

type BlockOf<K extends ReportBlock['kind']> = Extract<ReportBlock, { kind: K }>

/**
 * Блоки библиотеки для печати (ADR-0164): изображение, файлы, дашборд. Картинка приходит
 * data URL — браузеру движка хранилище недоступно; дашборд — его плитки с фильтрами по
 * умолчанию, в DOCX — снимком всей сетки.
 */

function PrintNotice({ block, text }: { block: ReportBlock; text: string }) {
  const model = useMemo<ReportPrintBlock[]>(
    () => [{ id: block.id, kind: 'notice', title: block.title, text }],
    [block.id, block.title, text],
  )
  useReportReady(block.id, model)
  return (
    <section className="flex flex-col gap-1.5 break-inside-avoid">
      {block.title ? <h2 className="text-sm font-semibold text-fg">{block.title}</h2> : null}
      <p className="rounded-md border border-dashed border-line px-3 py-3 text-xs text-fg-muted">
        {text}
      </p>
    </section>
  )
}

const failure = (error: unknown, t: ReturnType<typeof useT>): string =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)
    ? t('data.report.print.noAccess')
    : error instanceof ApiError
      ? error.message
      : t('data.report.print.failed')

export function PrintImage({ block, reportId }: { block: BlockOf<'image'>; reportId: string }) {
  const t = useT()
  const image = useQuery({
    queryKey: ['report', reportId, 'image', block.fileId],
    queryFn: () => http.get<ReportImage>(`/reports/${reportId}/images/${block.fileId}`),
    enabled: Boolean(block.fileId),
    retry: false,
  })
  const model = useMemo<ReportPrintBlock[] | null>(
    () =>
      image.data
        ? [{ id: block.id, kind: 'figure', title: block.title, figure: 'image', note: null }]
        : null,
    [image.data, block.id, block.title],
  )
  useReportReady(block.id, model)
  if (!block.fileId) return <PrintNotice block={block} text={t('data.report.print.emptyBlock')} />
  if (image.error) return <PrintNotice block={block} text={failure(image.error, t)} />
  if (!image.data) return null
  return (
    <section className="flex flex-col gap-2 break-inside-avoid">
      {block.title ? <h2 className="text-sm font-semibold text-fg">{block.title}</h2> : null}
      <figure data-print-figure={block.id} className="m-0 bg-surface">
        <img
          src={image.data.dataUrl}
          alt={block.title ?? image.data.name}
          className="mx-auto max-w-full object-contain"
          style={{ maxHeight: REPORT_FIGURE_HEIGHT[block.size] }}
        />
      </figure>
    </section>
  )
}

export function PrintFiles({ block, reportId }: { block: BlockOf<'file'>; reportId: string }) {
  const t = useT()
  const files = useQuery({
    queryKey: ['report', reportId, 'files', block.fileIds],
    queryFn: () =>
      http.get<{ items: Array<{ id: string; name: string; size: number }> }>(
        `/reports/${reportId}/files`,
        { query: { ids: block.fileIds.join(',') } },
      ),
    enabled: block.fileIds.length > 0,
    retry: false,
  })
  const items = files.data?.items ?? []
  const model = useMemo<ReportPrintBlock[] | null>(
    () =>
      files.data
        ? [
            {
              id: block.id,
              kind: 'text',
              body: {
                type: 'doc',
                content: [
                  ...(block.title
                    ? [
                        {
                          type: 'heading',
                          attrs: { level: 3 },
                          content: [{ type: 'text', text: block.title }],
                        },
                      ]
                    : []),
                  {
                    type: 'bulletList',
                    content: files.data.items.map((item) => ({
                      type: 'listItem',
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: item.name }] },
                      ],
                    })),
                  },
                ],
              },
            },
          ]
        : null,
    [files.data, block.id, block.title],
  )
  useReportReady(block.id, model)
  if (block.fileIds.length === 0) {
    return <PrintNotice block={block} text={t('data.report.print.emptyBlock')} />
  }
  if (files.error) return <PrintNotice block={block} text={failure(files.error, t)} />
  if (!files.data) return null
  if (items.length === 0) {
    return <PrintNotice block={block} text={t('data.report.print.noAccess')} />
  }
  return (
    <section className="flex flex-col gap-1.5 break-inside-avoid">
      <h2 className="text-sm font-semibold text-fg">
        {block.title ?? t('data.report.kinds.file')}
      </h2>
      <ul className="list-disc ps-5 text-sm text-fg">
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </section>
  )
}

export function PrintDashboard({ block }: { block: BlockOf<'dashboard'> }) {
  const t = useT()
  const { locale, timezone } = usePrint()
  const dashboard = useQuery({
    queryKey: ['dashboard', block.dashboardId],
    queryFn: () => http.get<DashboardRecord>(`/dashboards/${block.dashboardId}`),
    enabled: Boolean(block.dashboardId),
    retry: false,
  })
  const data = useQuery({
    queryKey: ['dashboard', block.dashboardId, 'print-data'],
    queryFn: () =>
      http.post<DashboardData>(`/dashboards/${block.dashboardId}/data`, { filters: {} }),
    enabled: Boolean(block.dashboardId),
    retry: false,
  })
  const model = useMemo<ReportPrintBlock[] | null>(
    () =>
      dashboard.data && data.data
        ? [
            {
              id: block.id,
              kind: 'figure',
              title: block.title ?? dashboard.data.name,
              figure: 'dashboard',
              note: null,
            },
          ]
        : null,
    [dashboard.data, data.data, block.id, block.title],
  )
  useReportReady(block.id, model)
  if (!block.dashboardId) {
    return <PrintNotice block={block} text={t('data.report.print.emptyBlock')} />
  }
  const error = dashboard.error ?? data.error
  if (error) return <PrintNotice block={block} text={failure(error, t)} />
  if (!dashboard.data || !data.data) return null
  const height = Math.round(REPORT_FIGURE_HEIGHT[block.size] * 0.7)
  const tiles = dashboard.data.spec.tiles.filter(
    (tile) => tile.kind === 'chart' || tile.kind === 'metric',
  )
  return (
    <section className="flex flex-col gap-2 break-inside-avoid">
      <h2 className="text-sm font-semibold text-fg">{block.title ?? dashboard.data.name}</h2>
      <figure data-print-figure={block.id} className="m-0 grid grid-cols-2 gap-3 bg-surface">
        {tiles.map((tile) => {
          const tileData = data.data?.tiles[tile.id]
          if (!tileData || tileData.error) {
            return (
              <p key={tile.id} className="text-xs text-fg-muted">
                {tile.title ?? ''} — {t('data.report.print.noAccess')}
              </p>
            )
          }
          if (tile.kind === 'metric' && tileData.metric) {
            return (
              <NumberTile
                key={tile.id}
                model={metricTileModel(tileData.metric, t, locale, tile.title ?? null)}
              />
            )
          }
          return tileData.spec && tileData.result ? (
            <div key={tile.id} className="flex flex-col gap-1">
              {tile.title ? (
                <span className="text-xs font-medium text-fg">{tile.title}</span>
              ) : null}
              <Chart
                spec={tileData.spec}
                result={tileData.result}
                height={height}
                animation={false}
                timezone={timezone}
              />
            </div>
          ) : null
        })}
      </figure>
    </section>
  )
}
