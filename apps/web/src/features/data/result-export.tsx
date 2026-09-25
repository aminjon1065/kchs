import { QUERY_EXPORT_HEADERS, type QueryExportFormat } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  type ChartHandle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  useToast,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Download, FileImage, FileSpreadsheet, FileText } from 'lucide-react'
import { type RefObject, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, downloadFile, saveBlob } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'

/** Виды графика без холста ECharts: таблица, число, сводная и карта — картинки у них нет. */
const NO_IMAGE = new Set(['table', 'number', 'pivot', 'map'])
export const chartHasImage = (type: string): boolean => !NO_IMAGE.has(type)

/** Символы, которых не бывает в имени файла. */
const UNSAFE_NAME = /[\\/:*?"<>|]+/g

/** Выгрузка данных: маршрут и тело без формата (формат добавляет меню). */
export interface ResultData {
  path: string
  body: Record<string, unknown>
}

/**
 * Меню «Экспорт» результата (ADR-0159): данные CSV и Excel — сервер считает
 * результат заново с политиками пользователя (нужна способность «Выгрузка
 * данных»); картинка PNG — кадр графика на экране.
 */
export function ResultExportMenu({
  data,
  chart,
  name,
  compact = false,
}: {
  data?: ResultData | null
  /** График на экране; без него пункта «PNG» нет. */
  chart?: RefObject<ChartHandle | null> | null
  /** Имя файла картинки (у данных имя даёт сервер). */
  name: string
  /** Кнопка-значок — для заголовка плитки дашборда. */
  compact?: boolean
}) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const [busy, setBusy] = useState(false)
  const withData = Boolean(data) && (me?.capabilities.includes('data.export') ?? false)
  if (!withData && !chart) return null

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    try {
      await task()
    } catch (error) {
      toast.show({
        title: error instanceof ApiError ? error.message : t('data.export.failed'),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }
  const exportData = (format: QueryExportFormat) =>
    run(async () => {
      if (!data) return
      const headers = await downloadFile(data.path, { ...data.body, format })
      if (headers.get(QUERY_EXPORT_HEADERS.truncated) === 'true') {
        const rows = Number(headers.get(QUERY_EXPORT_HEADERS.rows) ?? 0)
        toast.show({
          title: t('data.export.resultTruncated', { rows: formatNumber(rows, {}, { locale }) }),
          tone: 'warning',
        })
      }
    })
  const exportImage = () =>
    run(async () => {
      const blob = await chart?.current?.image()
      if (!blob) {
        toast.show({ title: t('data.export.noImage'), tone: 'warning' })
        return
      }
      saveBlob(blob, `${name.replace(UNSAFE_NAME, ' ').trim() || 'chart'}.png`)
    })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <IconButton label={t('data.export.action')} size="sm" disabled={busy}>
            <Download className="size-3.5" />
          </IconButton>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="size-3.5" />}
            loading={busy}
          >
            {t('data.export.action')}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {withData ? (
          <>
            <DropdownMenuItem
              icon={<FileText className="size-3.5" />}
              onSelect={() => void exportData('csv')}
            >
              {t('data.export.resultCsv')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<FileSpreadsheet className="size-3.5" />}
              onSelect={() => void exportData('xlsx')}
            >
              {t('data.export.resultXlsx')}
            </DropdownMenuItem>
          </>
        ) : null}
        {chart ? (
          <DropdownMenuItem
            icon={<FileImage className="size-3.5" />}
            onSelect={() => void exportImage()}
          >
            {t('data.export.resultPng')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
