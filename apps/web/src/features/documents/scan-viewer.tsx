import type { FilePreviews } from '@kchs/contracts'
import { cn, EmptyState, IconButton, ObjectIcon, Skeleton, Spinner, Tooltip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'

const PENDING = new Set(['queued', 'processing'])
const ZOOMS = [50, 75, 100, 125, 150, 200, 300] as const

/**
 * Просмотрщик скана и PDF-представления (03-screens.md §12 «Регистрация»):
 * страницы, построенные движком, с масштабом — по ширине области и ступенями
 * 50–300 %. Пока движок строит превью, панель ждёт (опрос раз в 4 секунды,
 * realtime обновляет раньше). Слот `overlay` — подсветка зон второй волны.
 */
export function ScanViewer({
  fileId,
  overlay,
  className,
}: {
  fileId: string | null
  overlay?: (page: number) => ReactNode
  className?: string
}) {
  const t = useT()
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const previews = useQuery({
    queryKey: fileId ? keys.filePreviews(fileId) : ['object', 'none', 'previews'],
    queryFn: () => http.get<FilePreviews>(`/files/${fileId}/previews`),
    enabled: Boolean(fileId),
    staleTime: 5 * 60_000,
    refetchInterval: (query) =>
      query.state.data && PENDING.has(query.state.data.previewStatus) ? 4000 : false,
  })

  const step = (direction: 1 | -1) => {
    const current = zoom === 'fit' ? 100 : zoom
    const index = ZOOMS.findIndex((value) => value >= current)
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (index < 0 ? 2 : index) + direction))]
    setZoom(next ?? 100)
  }

  const data = previews.data
  const pages = data?.items.filter((item) => item.kind === 'page') ?? []
  const web = data?.items.find((item) => item.kind === 'web')
  const images = pages.length > 0 ? pages : web ? [web] : []
  const width = zoom === 'fit' ? '100%' : `${zoom}%`

  return (
    <section
      aria-label={t('documents.viewer.title')}
      className={cn('flex h-full min-h-0 flex-col bg-surface-2', className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex-1 truncate text-xs text-fg-muted">
          {data?.pages
            ? t('files.preview.pages', { count: data.pages })
            : t('documents.viewer.title')}
        </span>
        <Tooltip content={t('documents.viewer.zoomOut')}>
          <IconButton size="sm" label={t('documents.viewer.zoomOut')} onClick={() => step(-1)}>
            <ZoomOut className="size-3.5" />
          </IconButton>
        </Tooltip>
        <span
          className="min-w-12 whitespace-nowrap px-1 text-center text-xs tabular text-fg-secondary"
          aria-live="polite"
        >
          {zoom === 'fit' ? t('documents.viewer.fit') : `${zoom}%`}
        </span>
        <Tooltip content={t('documents.viewer.zoomIn')}>
          <IconButton size="sm" label={t('documents.viewer.zoomIn')} onClick={() => step(1)}>
            <ZoomIn className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('documents.viewer.fitWidth')}>
          <IconButton
            size="sm"
            label={t('documents.viewer.fitWidth')}
            onClick={() => setZoom('fit')}
          >
            <Maximize2 className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!fileId ? (
          <EmptyState
            compact
            icon={<ObjectIcon type="file" />}
            title={t('documents.viewer.empty')}
            description={t('documents.viewer.emptyHint')}
          />
        ) : previews.isLoading || !data ? (
          <Skeleton className="mx-auto h-[70vh] w-full max-w-[860px]" />
        ) : PENDING.has(data.previewStatus) ? (
          <Placeholder
            icon={<Spinner className="size-6" />}
            title={t('files.preview.processing')}
          />
        ) : images.length > 0 ? (
          <ol className="flex flex-col items-center gap-4">
            {images.map((image, index) => {
              const page = image.page ?? index + 1
              return (
                <li key={`${image.kind}-${page}`} className="relative" style={{ width }}>
                  <img
                    src={image.url}
                    alt={t('files.preview.page', { page, total: data.pages ?? images.length })}
                    loading={index > 1 ? 'lazy' : 'eager'}
                    width={image.width ?? undefined}
                    height={image.height ?? undefined}
                    className="h-auto w-full rounded-sm border border-line bg-surface shadow-sm"
                  />
                  {overlay ? (
                    <div className="pointer-events-none absolute inset-0">{overlay(page)}</div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : (
          <Placeholder
            icon={
              data.previewStatus === 'failed' ? (
                <AlertTriangle className="size-8 text-warning" aria-hidden />
              ) : (
                <ObjectIcon type="file" className="size-10 text-fg-muted" />
              )
            }
            title={
              data.previewStatus === 'failed'
                ? t('files.preview.failed')
                : t('files.preview.unsupported')
            }
          />
        )}
      </div>
    </section>
  )
}

function Placeholder({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon}
      <p className="text-sm text-fg-secondary">{title}</p>
    </div>
  )
}
