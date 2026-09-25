import {
  type Locale,
  PRINT_MODEL_VERSION,
  type ReportBlock,
  type ReportPrintBlock,
  type ReportPrintModel,
  type ReportPrintPayload,
} from '@kchs/contracts'
import { formatDate, formatDateTime, relativeRange } from '@kchs/fields'
import { ErrorState, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { territoriesQuery } from '~/features/gis/queries.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'
import { DashboardPrint } from './dashboard-print.js'
import {
  PrintChart,
  PrintMap,
  PrintMetrics,
  PrintPageBreak,
  PrintQuery,
  PrintText,
} from './print-blocks.js'
import { type PrintContextValue, PrintProvider, setPrintState, settleDom } from './print-context.js'
import type { PrintTarget } from './print-target.js'

declare global {
  interface Window {
    /** Модель документа для движка (ADR-0078): `window.kchsPrint`. */
    kchsPrint?: ReportPrintModel | { error: string }
  }
}

/**
 * Параметры отчёта одной строкой: период датами, территория, когда сформирован.
 * `ready` — подписи территорий загружены: в модель не уходит идентификатор.
 */
function useSubtitle(payload: ReportPrintPayload): { text: string; ready: boolean } {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const { period, territory } = payload.params
  const timezone = payload.user.timezone
  const { data: territories, isLoading } = useQuery({
    ...territoriesQuery(),
    enabled: Boolean(territory),
  })
  const parts: string[] = []
  if (period) {
    if ('unit' in period) {
      const range = relativeRange(period, new Date(payload.generatedAt), timezone)
      // Конец интервала не входит: последний день — на миллисекунду раньше
      const last = new Date(range.to.getTime() - 1)
      parts.push(
        t('data.report.print.period', {
          from: formatDate(range.from, { locale, timezone }),
          to: formatDate(last, { locale, timezone }),
        }),
      )
    } else {
      parts.push(
        t('data.report.print.period', {
          from: formatDate(period.from, { locale }),
          to: formatDate(period.to, { locale }),
        }),
      )
    }
  }
  if (territory) {
    const unit = territories?.find((item) => item.id === territory.id)
    parts.push(
      t('data.report.print.territory', {
        name: unit ? (unit.name[locale] ?? unit.name.ru) : territory.id,
      }),
    )
  }
  parts.push(
    t('data.report.print.generated', {
      date: formatDateTime(payload.generatedAt, { locale, timezone }),
    }),
  )
  return { text: parts.join(' · '), ready: !territory || !isLoading }
}

function PrintBlock({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case 'text':
      return <PrintText block={block} />
    case 'query':
      return <PrintQuery block={block} />
    case 'chart':
      return <PrintChart block={block} />
    case 'metrics':
      return <PrintMetrics block={block} />
    case 'map':
      return <PrintMap block={block} />
    case 'page_break':
      return <PrintPageBreak block={block} />
  }
}

/**
 * Документ отчёта для печати (ADR-0078): каждый блок сообщает свою часть модели,
 * когда дорисован; когда готовы все и страница успокоилась — модель в
 * `window.kchsPrint`, а `<html data-print-state="ready">` — сигнал движку.
 */
function PrintDocument({ payload }: { payload: ReportPrintPayload }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const { report } = payload
  const { text: subtitle, ready: subtitleReady } = useSubtitle(payload)
  const models = useRef(new Map<string, ReportPrintBlock[]>())
  const [readyCount, setReadyCount] = useState(0)
  const published = useRef(false)

  const onReady = useCallback((blockId: string, model: ReportPrintBlock[]) => {
    models.current.set(blockId, model)
    setReadyCount(models.current.size)
  }, [])

  const context = useMemo<PrintContextValue>(
    () => ({
      params: payload.params,
      timezone: payload.user.timezone,
      locale,
      canSql: payload.user.canSql,
      report: onReady,
    }),
    [payload, locale, onReady],
  )

  useEffect(() => {
    document.title = report.name
  }, [report.name])

  const all = subtitleReady && report.blocks.every((block) => models.current.has(block.id))
  // biome-ignore lint/correctness/useExhaustiveDependencies: readyCount — сигнал «блок дорисован» (модели — в ref)
  useEffect(() => {
    if (!all || published.current) return
    let cancelled = false
    void settleDom().then(() => {
      if (cancelled) return
      published.current = true
      window.kchsPrint = {
        version: PRINT_MODEL_VERSION,
        title: report.name,
        subtitle,
        settings: report.settings,
        labels: { page: t('data.report.print.page'), of: t('data.report.print.of') },
        blocks: report.blocks.flatMap((block) => models.current.get(block.id) ?? []),
      }
      setPrintState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [all, readyCount, report, subtitle, t])

  return (
    <PrintProvider value={context}>
      <article className="mx-auto flex max-w-[1040px] flex-col gap-6 bg-surface p-6 text-fg print:max-w-none print:p-0">
        {report.settings.titlePage ? (
          <header className="flex min-h-[60vh] flex-col justify-center gap-4 break-after-page">
            <h1 className="text-3xl font-semibold text-fg">{report.name}</h1>
            <p className="text-sm text-fg-secondary">{subtitle}</p>
            <p className="text-sm text-fg-muted">
              {t('data.report.print.preparedFor', { name: payload.user.displayName })}
            </p>
          </header>
        ) : (
          <header className="flex flex-col gap-1 border-b border-line pb-3">
            <h1 className="text-xl font-semibold text-fg">{report.name}</h1>
            <p className="text-xs text-fg-secondary">{subtitle}</p>
          </header>
        )}
        {report.blocks.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('data.report.print.emptyReport')}</p>
        ) : null}
        {report.blocks.map((block) => (
          <PrintBlock key={block.id} block={block} />
        ))}
      </article>
    </PrintProvider>
  )
}

/** Страницы печати вне оболочки: отчёт (ADR-0078) и дашборд (ADR-0159). */
export default function PrintScreen({ target }: { target: PrintTarget }) {
  if (target.kind === 'dashboard') {
    return <DashboardPrint dashboardId={target.dashboardId} filters={target.filters} />
  }
  return <ReportPrint target={target} />
}

/**
 * Страница печати отчёта вне оболочки (03-screens.md §21, ADR-0078): браузер
 * движка со служебным токеном (cookie) или пользователь — предпросмотр и печать
 * своего запуска. Всегда светлая тема: печать — на бумаге.
 */
function ReportPrint({ target }: { target: Exclude<PrintTarget, { kind: 'dashboard' }> }) {
  const t = useT()
  // Сессия пользователя (предпросмотр в новой вкладке) — CSRF-токен из /me;
  // у браузера движка сессии нет, и /me ему недоступен — это не ошибка
  const me = useQuery({
    queryKey: ['print', 'me'],
    queryFn: () =>
      http.get<{ session: { csrfToken: string } }>('/me', { anonymous: true }).catch(() => null),
    retry: false,
  })
  useEffect(() => {
    if (me.data?.session.csrfToken) setCsrfToken(me.data.session.csrfToken)
  }, [me.data])

  const payload = useQuery({
    queryKey: ['print', 'payload', target],
    queryFn: () =>
      http.get<ReportPrintPayload>(
        target.kind === 'run'
          ? `/print/report-runs/${target.runId}`
          : `/print/reports/${target.reportId}`,
        { anonymous: true },
      ),
    enabled: !me.isLoading,
    retry: false,
  })

  // Бумага: светлая тема и плотные строки таблиц — только на этой странице,
  // сохранённое оформление пользователя не меняется
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = 'light'
    root.dataset.density = 'compact'
    root.dataset.print = 'report'
    return () => {
      delete root.dataset.print
    }
  }, [])

  const error = payload.error
  useEffect(() => {
    if (!error) return
    window.kchsPrint = {
      error: error instanceof ApiError ? error.message : t('data.report.print.failed'),
    }
    setPrintState('error')
  }, [error, t])

  if (error) {
    return (
      <ErrorState
        title={t('data.report.print.unavailable')}
        description={error instanceof ApiError ? error.message : undefined}
      />
    )
  }
  if (!payload.data) {
    return (
      <div className="mx-auto flex max-w-[1040px] flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  return <PrintDocument payload={payload.data} />
}
