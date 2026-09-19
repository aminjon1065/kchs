import type { FilePreviews, FileText } from '@kchs/contracts'
import { ObjectIcon, Skeleton, Spinner } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { WatermarkLayer } from './watermark-layer.js'

const PENDING = new Set(['queued', 'processing'])

/**
 * Единый просмотрщик файла (09-files.md §3): страницы PDF и офисных документов,
 * изображения, текст. Превью строит движок; пока он работает, вкладка ждёт
 * события realtime, а на случай его потери — опрашивает раз в 4 секунды.
 */
export function FilePreview({
  fileId,
  cacheScope,
  watermark,
}: {
  fileId: string
  /** Отдельный кэш для гостевого просмотра по ссылке. */
  cacheScope?: string
  /** Водяной знак гостевой ссылки поверх превью. */
  watermark?: string | null
}) {
  const t = useT()
  const previews = useQuery({
    queryKey: cacheScope ? [cacheScope, ...keys.filePreviews(fileId)] : keys.filePreviews(fileId),
    queryFn: () => http.get<FilePreviews>(`/files/${fileId}/previews`),
    // Подписанные ссылки живут 15 минут — обновляем заранее
    staleTime: 5 * 60_000,
    refetchInterval: (query) =>
      query.state.data && PENDING.has(query.state.data.previewStatus) ? 4000 : false,
  })

  const data = previews.data
  const showText =
    data !== undefined && data.previewStatus === 'unsupported' && data.textStatus === 'ready'
  const text = useQuery({
    queryKey: cacheScope ? [cacheScope, ...keys.fileText(fileId)] : keys.fileText(fileId),
    queryFn: () => http.get<FileText>(`/files/${fileId}/text`),
    enabled: showText,
    staleTime: 5 * 60_000,
  })

  if (previews.isLoading || !data) {
    return (
      <Frame>
        <Skeleton className="h-64 w-full" />
      </Frame>
    )
  }

  if (PENDING.has(data.previewStatus)) {
    return (
      <Frame>
        <Placeholder icon={<Spinner className="size-6" />} title={t('files.preview.processing')} />
      </Frame>
    )
  }

  const pages = data.items.filter((item) => item.kind === 'page')
  const web = data.items.find((item) => item.kind === 'web')
  // Файл с грифом — знак с именем смотрящего (ADR-0085), гостевая ссылка — своя метка
  const mark = data.watermark?.lines ?? null

  if (data.previewStatus === 'ready' && (pages.length > 0 || web)) {
    return (
      <Frame watermark={watermark} lines={mark}>
        {web ? (
          <img
            src={web.url}
            alt=""
            width={web.width ?? undefined}
            height={web.height ?? undefined}
            className="mx-auto h-auto max-h-[70vh] w-auto max-w-full rounded-sm"
          />
        ) : (
          <ol
            className="flex flex-col items-center gap-4"
            aria-label={t('files.preview.pages', { count: data.pages ?? pages.length })}
          >
            {pages.map((page) => (
              <li key={page.page ?? 0} className="flex w-full flex-col items-center gap-1.5">
                <img
                  src={page.url}
                  alt={t('files.preview.page', {
                    page: page.page ?? 1,
                    total: data.pages ?? pages.length,
                  })}
                  loading="lazy"
                  width={page.width ?? undefined}
                  height={page.height ?? undefined}
                  className="h-auto w-full max-w-[860px] rounded-sm border border-line shadow-sm"
                />
                <span className="text-2xs text-fg-muted tabular">
                  {t('files.preview.page', {
                    page: page.page ?? 1,
                    total: data.pages ?? pages.length,
                  })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Frame>
    )
  }

  if (showText) {
    return (
      <Frame watermark={watermark} lines={mark}>
        {text.data?.text ? (
          <div className="flex flex-col gap-2">
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-4 font-mono text-xs text-fg">
              {text.data.text}
            </pre>
            {text.data.truncated ? (
              <p className="text-2xs text-fg-muted">{t('files.preview.textTruncated')}</p>
            ) : null}
          </div>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </Frame>
    )
  }

  return (
    <Frame>
      {data.previewStatus === 'failed' ? (
        <Placeholder
          icon={<AlertTriangle className="size-8 text-warning" aria-hidden />}
          title={t('files.preview.failed')}
        />
      ) : (
        <Placeholder
          icon={<ObjectIcon type="file" className="size-10 text-fg-muted" />}
          title={t('files.preview.unsupported')}
        />
      )}
    </Frame>
  )
}

function Frame({
  children,
  watermark,
  lines,
}: {
  children: ReactNode
  watermark?: string | null
  lines?: string[] | null
}) {
  return (
    <div className="relative overflow-hidden rounded-md bg-surface-2 p-4">
      {children}
      {lines ? (
        <WatermarkLayer lines={lines} tone="danger" />
      ) : watermark ? (
        <WatermarkLayer lines={[watermark]} />
      ) : null}
    </div>
  )
}

function Placeholder({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon}
      <p className="text-sm text-fg-secondary">{title}</p>
    </div>
  )
}
