import { isDeepStrictEqual } from 'node:util'
import {
  DEFAULT_REPORT_SETTINGS,
  REPORT_DOC,
  ReportBlock,
  type ReportImage,
  type ReportParams,
  type ReportSettings,
  type ReportTemplate,
  type ReportVersion,
  type ReportVersionReason,
  type UserRef,
} from '@kchs/contracts'
import { and, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { CollabService } from '~/kernel/collab/server.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { getObjectStream } from '~/kernel/storage/s3.js'
import { fileBriefs, fileBuckets, watermarkLevel } from '~/modules/files/public.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, reports, reportVersions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { insertReportBlocks, type ReportBody } from './report-doc.js'

/**
 * Библиотека отчётов (ADR-0164): версии шаблона с откатом, встроенные шаблоны КЧС и отчёты,
 * отмеченные шаблоном, картинки блока «Изображение» для печати.
 */

/** Картинка блока «Изображение» — не больше, иначе печать тяжелеет без пользы. */
const IMAGE_BYTES = 8 * 1024 * 1024
const HISTORY_LIMIT = 50

const text = (value: string) => ({ type: 'text', text: value })
const heading = (value: string, level = 2) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
})
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] })
const textBlock = (id: string, ...content: Record<string, unknown>[]) =>
  ReportBlock.parse({ id, kind: 'text', body: { type: 'doc', content } })

/**
 * Встроенные шаблоны КЧС: каркас разделов с подсказками, источники выбирает автор. Тексты —
 * на основном языке (русском): отчёт после создания правится как обычно.
 */
const BUILTIN: ReadonlyArray<{
  key: string
  name: string
  description: string
  blocks: ReportBlock[]
  params: ReportParams
  settings: ReportSettings
}> = [
  {
    key: 'daily-summary',
    name: 'Ежедневная оперативная сводка',
    description: 'Обстановка за сутки: происшествия, показатели, карта, принятые меры.',
    params: { period: { unit: 'day', from: -1, to: -1 }, territory: null },
    settings: { ...DEFAULT_REPORT_SETTINGS, titlePage: false, numbering: true },
    blocks: [
      textBlock(
        't_daily_1',
        heading('Оперативная обстановка за сутки'),
        paragraph('Кратко: что произошло, где, сколько пострадавших, какие силы привлечены.'),
      ),
      ReportBlock.parse({ id: 't_daily_2', kind: 'metrics', title: 'Показатели за сутки' }),
      ReportBlock.parse({ id: 't_daily_3', kind: 'query', title: 'Происшествия за сутки' }),
      ReportBlock.parse({ id: 't_daily_4', kind: 'map', title: 'Происшествия на карте' }),
      textBlock(
        't_daily_5',
        heading('Принятые меры'),
        paragraph('Действия дежурных служб, оповещение населения, распоряжения руководства.'),
      ),
    ],
  },
  {
    key: 'flood-season',
    name: 'Итоги паводкового сезона',
    description: 'Характеристика сезона, динамика, ущерб, карта подтоплений и выводы.',
    params: { period: { unit: 'month', from: -3, to: 0 }, territory: null },
    settings: { ...DEFAULT_REPORT_SETTINGS, titlePage: true, toc: true, numbering: true },
    blocks: [
      textBlock(
        't_flood_1',
        heading('Общая характеристика сезона'),
        paragraph('Сроки, водность рек, отличия от прошлых лет.'),
      ),
      ReportBlock.parse({ id: 't_flood_2', kind: 'chart', title: 'Динамика происшествий' }),
      ReportBlock.parse({ id: 't_flood_3', kind: 'map', title: 'Подтопленные территории' }),
      textBlock(
        't_flood_4',
        heading('Ущерб и пострадавшие'),
        paragraph('Пострадавшие, эвакуированные, разрушенные дома, дороги и мосты.'),
      ),
      ReportBlock.parse({ id: 't_flood_5', kind: 'query', title: 'Ущерб по районам' }),
      textBlock(
        't_flood_6',
        heading('Выводы и предложения'),
        paragraph('Что сработало, что нет; меры к следующему сезону.'),
      ),
    ],
  },
  {
    key: 'instructions-control',
    name: 'Исполнение поручений',
    description: 'Контроль исполнения: показатели, просроченные поручения, выводы.',
    params: { period: { unit: 'month', from: 0, to: 0 }, territory: null },
    settings: { ...DEFAULT_REPORT_SETTINGS, numbering: true },
    blocks: [
      textBlock(
        't_instr_1',
        heading('Исполнение поручений за период'),
        paragraph('Сколько выдано, исполнено в срок, просрочено; по подразделениям.'),
      ),
      ReportBlock.parse({ id: 't_instr_2', kind: 'metrics', title: 'Показатели исполнения' }),
      ReportBlock.parse({ id: 't_instr_3', kind: 'query', title: 'Просроченные поручения' }),
      textBlock('t_instr_4', heading('Выводы'), paragraph('Причины просрочек и предложения.')),
    ],
  },
]

function bodyOf(row: { blocks: unknown; params: unknown; settings: unknown }): ReportBody {
  return {
    blocks: row.blocks as ReportBlock[],
    params: row.params as ReportParams,
    settings: { ...DEFAULT_REPORT_SETTINGS, ...(row.settings as Partial<ReportSettings>) },
  }
}

async function currentBody(executor: Executor, reportId: string): Promise<ReportBody> {
  const [row] = await executor
    .select({ blocks: reports.blocks, params: reports.params, settings: reports.settings })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1)
  if (!row) throw errors.notFound('Отчёт')
  return bodyOf(row)
}

export const ReportVersions = {
  /** «Сохранить версию»: открытый документ сначала сбрасывается в базу. */
  async save(ctx: UserCtx, reportId: string, label: string | null): Promise<number> {
    await CollabService.change(ctx, { id: reportId, type: 'report' }, () => {})
    return db().transaction((tx) => ReportVersions.record(tx, ctx, reportId, 'manual', label))
  },

  async record(
    tx: Executor,
    ctx: Ctx,
    reportId: string,
    reason: ReportVersionReason,
    label: string | null = null,
  ): Promise<number> {
    const body = await currentBody(tx, reportId)
    const [last] = await tx
      .select({ number: max(reportVersions.number) })
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId))
    const number = (last?.number ?? 0) + 1
    const id = newId()
    await tx.insert(reportVersions).values({
      id,
      reportId,
      number,
      blocks: body.blocks,
      params: body.params as unknown as Record<string, unknown>,
      settings: body.settings as unknown as Record<string, unknown>,
      reason,
      label,
      createdBy: actorId(ctx),
    })
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, reportId))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'report.version_saved',
      object: {
        id: reportId,
        type: 'report',
        spaceId: object?.spaceId ?? null,
        title: object?.title ?? '',
      },
      payload: { versionId: id, number, reason },
    })
    return number
  },

  /** Снимок, только если шаблон изменился с последней версии (формирование, откат). */
  async recordIfChanged(tx: Executor, ctx: Ctx, reportId: string, reason: ReportVersionReason) {
    const body = await currentBody(tx, reportId)
    const [last] = await tx
      .select({
        blocks: reportVersions.blocks,
        params: reportVersions.params,
        settings: reportVersions.settings,
      })
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId))
      .orderBy(desc(reportVersions.number))
      .limit(1)
    if (last && isDeepStrictEqual(bodyOf(last), body)) return null
    return ReportVersions.record(tx, ctx, reportId, reason)
  },

  async list(reportId: string): Promise<ReportVersion[]> {
    const rows = await db()
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId))
      .orderBy(desc(reportVersions.number))
      .limit(HISTORY_LIMIT)
    const refs = await directory().refs(
      rows.map((row) => row.createdBy).filter((id): id is string => Boolean(id)),
    )
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      reason: row.reason as ReportVersionReason,
      label: row.label,
      blocks: (row.blocks as unknown[]).length,
      createdBy: row.createdBy ? ((refs.get(row.createdBy) as UserRef | undefined) ?? null) : null,
      createdAt: row.createdAt,
    }))
  },

  /**
   * Откат: текущий шаблон — версией (если менялся), затем снимок версии пишется в документ
   * Yjs сервером — у соавторов он появляется сразу, JSON-снимок обновляет сервер правки.
   */
  async restore(ctx: UserCtx, reportId: string, versionId: string): Promise<void> {
    const [row] = await db()
      .select()
      .from(reportVersions)
      .where(and(eq(reportVersions.id, versionId), eq(reportVersions.reportId, reportId)))
      .limit(1)
    if (!row) throw errors.notFound('Версия отчёта')
    const body = bodyOf(row)
    // Открытый документ — в базу, чтобы текущий шаблон попал в версию целиком (как у страниц)
    await CollabService.change(ctx, { id: reportId, type: 'report' }, () => {})
    await db().transaction((tx) => ReportVersions.recordIfChanged(tx, ctx, reportId, 'restore'))
    await CollabService.change(ctx, { id: reportId, type: 'report' }, (doc) => {
      const order = doc.getArray<string>(REPORT_DOC.order)
      const cells = doc.getMap<unknown>(REPORT_DOC.blocks)
      order.delete(0, order.length)
      for (const key of [...cells.keys()]) cells.delete(key)
      insertReportBlocks(doc, body.blocks)
      const params = doc.getMap<unknown>(REPORT_DOC.params)
      params.set('period', body.params.period)
      params.set('territory', body.params.territory)
      const settings = doc.getMap<unknown>(REPORT_DOC.settings)
      for (const [key, value] of Object.entries(body.settings)) settings.set(key, value)
    })
  },
}

export const ReportTemplates = {
  /** Встроенные шаблоны и отчёты-шаблоны, которые видит пользователь. */
  async list(ctx: UserCtx): Promise<ReportTemplate[]> {
    const builtin: ReportTemplate[] = BUILTIN.map((item) => ({
      id: `builtin:${item.key}`,
      source: 'builtin',
      key: item.key,
      name: item.name,
      description: item.description,
      blocks: item.blocks,
      params: item.params,
      settings: item.settings,
    }))
    const rows = await db()
      .select({
        id: objects.id,
        title: objects.title,
        subtitle: objects.subtitle,
        blocks: reports.blocks,
        params: reports.params,
        settings: reports.settings,
      })
      .from(reports)
      .innerJoin(objects, eq(objects.id, reports.id))
      .where(and(isNull(objects.deletedAt), sql`${objects.meta} ->> 'template' = 'true'`))
      .orderBy(objects.title)
      .limit(100)
    const own: ReportTemplate[] = []
    for (const row of rows) {
      if (!(await authorize(ctx, 'view', row.id, { soft: true })).allowed) continue
      const body = bodyOf(row)
      own.push({
        id: row.id,
        source: 'report',
        key: null,
        name: row.title,
        description: row.subtitle,
        ...body,
      })
    }
    return [...builtin, ...own]
  },

  /** «Сохранить как шаблон» / снять отметку: признак в сводке объекта реестра. */
  async flag(tx: Executor, ctx: Ctx, reportId: string, template: boolean): Promise<void> {
    const object = await ObjectService.update(
      tx,
      ctx,
      reportId,
      { meta: { template }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'report.updated',
      object: { id: reportId, type: 'report', spaceId: object.spaceId, title: object.title },
      payload: { changed: ['template'] },
    })
  },

  async isTemplate(reportId: string): Promise<boolean> {
    const [row] = await db()
      .select({ template: sql<string | null>`${objects.meta} ->> 'template'` })
      .from(objects)
      .where(eq(objects.id, reportId))
      .limit(1)
    return row?.template === 'true'
  },
}

/**
 * Картинка блока «Изображение» (ADR-0164) — data URL для страницы печати и редактора: так
 * она доходит и до браузера движка, которому хранилище файлов недоступно. Файл с грифом не
 * отдаётся: печать копий с водяным знаком — отдельный путь (ADR-0085).
 */
export async function reportImage(ctx: UserCtx, fileId: string): Promise<ReportImage> {
  await authorize(ctx, 'download', fileId)
  if (await watermarkLevel(fileId)) {
    throw errors.forbidden('Файл с грифом в отчёт не печатается')
  }
  const brief = (await fileBriefs([fileId])).get(fileId)
  if (!brief?.mime.startsWith('image/')) throw errors.validation('Файл — не изображение')
  if (brief.size > IMAGE_BYTES) throw errors.validation('Изображение больше 8 МБ')
  const object = await getObjectStream(brief.storageKey, { bucket: fileBuckets.files() })
  const parts: Buffer[] = []
  for await (const part of object.body) parts.push(Buffer.from(part))
  return {
    name: brief.name,
    dataUrl: `data:${brief.mime};base64,${Buffer.concat(parts).toString('base64')}`,
  }
}

/** Файлы блока «Файл», которые видит пользователь: названия и размеры для списка. */
export async function reportFiles(
  ctx: UserCtx,
  fileIds: string[],
): Promise<Array<{ id: string; name: string; size: number; mime: string }>> {
  const visible: string[] = []
  for (const id of fileIds) {
    if ((await authorize(ctx, 'view', id, { soft: true })).allowed) visible.push(id)
  }
  const briefs = await fileBriefs(visible)
  const rows = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(inArray(objects.id, visible.length > 0 ? visible : [newId()]), isNull(objects.deletedAt)),
    )
  const alive = new Set(rows.map((row) => row.id))
  return visible
    .filter((id) => alive.has(id) && briefs.has(id))
    .map((id) => {
      const brief = briefs.get(id) as { name: string; size: number; mime: string }
      return { id, name: brief.name, size: brief.size, mime: brief.mime }
    })
}
