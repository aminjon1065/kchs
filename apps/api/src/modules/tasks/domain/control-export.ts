import type { Writable } from 'node:stream'
import type { ControlBucket, ControlListQuery, ControlQuery, Locale } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { type ExportColumn, writeTable } from '~/modules/data/public.js'
import type { UserCtx } from '~/shared/context.js'
import { ControlService } from './control-service.js'

export interface ControlExportInput extends ControlQuery {
  view: 'matrix' | 'list'
  bucket: ControlBucket
  /** Строка матрицы списка: подразделение или `none`; без неё — все подразделения. */
  row?: string | undefined
  format: 'csv' | 'xlsx'
}

/** Строк списка в выгрузке не больше — как у интерактивного списка. */
const LIST_LIMIT = 500

/**
 * Выгрузка экрана «Контроль» (03-screens.md §12, ADR-0082): матрица
 * «подразделения × состояния» с итогом или список поручений ячейки — в CSV
 * или XLSX, подписи — на языке смотрящего, права — его же.
 */
export async function controlExport(
  ctx: UserCtx,
  input: ControlExportInput,
  out: Writable,
): Promise<void> {
  const t = createTranslator(ctx.locale as Locale)
  const { view, bucket, row, format, ...query } = input
  const options = (columns: ExportColumn[]) => ({
    columns,
    timezone: ctx.timezone,
    sheetName: t(view === 'matrix' ? 'tasks.control.title' : `tasks.control.buckets.${bucket}`),
  })

  if (view === 'matrix') {
    const report = await ControlService.report(ctx, query)
    const columns: ExportColumn[] = [
      { name: 'unit', label: t('tasks.control.unit'), type: 'text' },
      { name: 'onTrack', label: t('tasks.control.buckets.on_track'), type: 'integer' },
      { name: 'dueToday', label: t('tasks.control.buckets.due_today'), type: 'integer' },
      { name: 'overdue', label: t('tasks.control.buckets.overdue'), type: 'integer' },
      { name: 'extended', label: t('tasks.control.buckets.extended'), type: 'integer' },
      { name: 'doneOnTime', label: t('tasks.control.buckets.done_on_time'), type: 'integer' },
      { name: 'doneLate', label: t('tasks.control.buckets.done_late'), type: 'integer' },
      { name: 'total', label: t('tasks.control.buckets.total'), type: 'integer' },
    ]
    const rows = [
      ...report.rows.map((row) => ({
        unit: row.unitName
          ? [...row.unitPath, row.unitName].join(' › ')
          : t('tasks.control.noUnit'),
        ...row.counts,
      })),
      { unit: t('tasks.control.totals'), ...report.totals },
    ]
    await writeTable(format, out, batches(rows), options(columns))
    return
  }

  const list = await ControlService.list(ctx, {
    ...query,
    bucket,
    ...(row ? { row: row as ControlListQuery['row'] } : {}),
    limit: LIST_LIMIT,
  })
  const columns: ExportColumn[] = [
    { name: 'key', label: t('tasks.fields.key'), type: 'text' },
    { name: 'title', label: t('tasks.fields.title'), type: 'text' },
    { name: 'state', label: t('tasks.control.state'), type: 'text' },
    { name: 'assignee', label: t('tasks.fields.assignee'), type: 'text' },
    { name: 'unit', label: t('tasks.control.unit'), type: 'text' },
    { name: 'author', label: t('tasks.fields.author'), type: 'text' },
    { name: 'controller', label: t('tasks.fields.controller'), type: 'text' },
    { name: 'dueAt', label: t('tasks.fields.due'), type: 'datetime' },
    { name: 'completedAt', label: t('tasks.fields.completed'), type: 'datetime' },
    { name: 'daysLate', label: t('tasks.control.daysLate'), type: 'integer' },
    { name: 'extensions', label: t('tasks.control.extensions'), type: 'integer' },
  ]
  const rows = list.items.map((item) => ({
    key: item.key,
    title: item.title,
    state: t(`tasks.control.buckets.${item.state}`),
    assignee: item.assignee?.displayName ?? '',
    unit: item.unitName ?? '',
    author: item.author?.displayName ?? '',
    controller: item.controller?.displayName ?? '',
    dueAt: item.dueAt,
    completedAt: item.completedAt,
    daysLate: item.daysLate,
    extensions: item.extensions,
  }))
  await writeTable(format, out, batches(rows), options(columns))
}

async function* batches(
  rows: Array<Record<string, unknown>>,
): AsyncGenerator<ReadonlyArray<Record<string, unknown>>> {
  yield rows
}
