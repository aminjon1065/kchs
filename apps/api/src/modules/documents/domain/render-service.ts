import {
  classifyPlaceholders,
  type DocumentRenderDownload,
  type DocumentRenderKind,
  type DocumentRenderPlan,
  type DocumentRenderRecord,
  type DocumentRenderResult,
  type DocumentRenderStart,
  type DocumentRenderStatus,
  type DocumentRenderTarget,
  type DocumentStatus,
  isDocumentClosed,
  isRedacted,
  PRINT_PERIOD_MAX_DAYS,
  type PrintFormInfo,
  type PrintRequestInput,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import { buckets, signedGetUrl } from '~/kernel/storage/s3.js'
import {
  fileBriefs,
  fileBuckets,
  fileStorageKey,
  registerGeneratedFile,
  watermarkLevel,
  watermarkLines,
} from '~/modules/files/public.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documentRenders, templates } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { DocumentService } from './document-service.js'
import { printPage } from './print/html.js'
import {
  type PrintContext,
  type PrintFormDefinition,
  type PrintParams,
  printForm,
  printFormsFor,
} from './print/registry.js'
import { watermarkOverlay } from './print/watermark-overlay.js'
import {
  enqueueRender,
  loadSubject,
  RENDER_JOB,
  type RenderRow,
  type RenderSubject,
} from './render-queue.js'
import { templateContext } from './template-context.js'
import { DOCX_MIME, DocumentTemplateService, loadTemplate } from './template-service.js'
import { DocumentTypeService } from './type-service.js'
import { DocumentVersionService } from './version-service.js'

export { RENDER_JOB }

const ACTIVE: DocumentRenderStatus[] = ['queued', 'running']
const PDF_MIME = 'application/pdf'
/** Повторное нажатие «Печать» в это окно возвращает уже заказанный рендер. */
const DUPLICATE_WINDOW_MS = 2 * 60_000

async function orgName(): Promise<string> {
  const value = await SettingsService.get<unknown>(
    SETTING_KEYS.brandName,
    [{ scope: 'system' }],
    '',
  )
  return typeof value === 'string' && value.trim() ? value.trim() : 'kchs'
}

async function printContext(ctx: UserCtx): Promise<PrintContext> {
  return {
    ctx,
    t: createTranslator(ctx.locale),
    locale: ctx.locale,
    timezone: ctx.timezone,
    org: await orgName(),
    now: new Date(),
  }
}

/** Формы из `printForms` типа документа; у журнала и других объектов — все формы типа. */
async function listedForms(subject: RenderSubject): Promise<Set<string> | null> {
  if (subject.type !== 'document') return null
  const row = await DocumentService.load(db(), subject.id)
  const type = row ? await DocumentTypeService.load(db(), row.typeId) : null
  return new Set(type?.printForms ?? [])
}

function formAllowed(
  form: PrintFormDefinition,
  subject: RenderSubject,
  listed: Set<string> | null,
): boolean {
  if (form.subjectType !== subject.type) return false
  if (subject.type === 'document' && form.typeListed !== false)
    return listed?.has(form.key) ?? false
  return true
}

function periodDays(period: { from: string; to: string }): number {
  return Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1
}

async function loadRow(executor: Executor, id: string, lock = false): Promise<RenderRow | null> {
  const query = executor.select().from(documentRenders).where(eq(documentRenders.id, id)).limit(1)
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

/** Имя файла без расширения — основа имени результата. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function safeFileName(name: string, extension: string): string {
  const cleaned = [...name]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
  return `${cleaned || 'document'}.${extension}`
}

async function toRecords(rows: RenderRow[]): Promise<DocumentRenderRecord[]> {
  const fileIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.fileId, row.kind === 'watermark' ? row.formKey : null])
        .filter((v): v is string => !!v),
    ),
  ]
  const templateIds = [
    ...new Set(
      rows
        .filter((row) => row.kind === 'fill' || row.kind === 'inspect')
        .map((row) => (row.kind === 'fill' ? row.formKey : row.subjectId))
        .filter((v): v is string => !!v),
    ),
  ]
  const [briefs, people, templates] = await Promise.all([
    fileBriefs(fileIds),
    directory().refs([
      ...new Set(rows.map((row) => row.requestedBy).filter((v): v is string => !!v)),
    ]),
    DocumentTemplateService.names(templateIds),
  ])
  return rows.map((row) => {
    const brief = row.fileId ? briefs.get(row.fileId) : undefined
    const form = row.kind === 'print' && row.formKey ? printForm(row.formKey) : null
    const label =
      row.kind === 'fill'
        ? (templates.get(row.formKey ?? '') ?? null)
        : row.kind === 'inspect'
          ? (templates.get(row.subjectId) ?? null)
          : row.kind === 'watermark'
            ? (briefs.get(row.formKey ?? '')?.name ?? null)
            : null
    return {
      id: row.id,
      kind: row.kind as DocumentRenderKind,
      subjectId: row.subjectId,
      form: row.formKey,
      labelKey: form?.labelKey ?? null,
      label,
      status: row.status as DocumentRenderStatus,
      file: brief ? { id: brief.id, name: brief.name, mime: brief.mime, size: brief.size } : null,
      pages: row.pages,
      error: row.error,
      requestedBy: row.requestedBy ? (people.get(row.requestedBy) ?? null) : null,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }
  })
}

async function fail(tx: Executor, row: RenderRow, message: string): Promise<void> {
  const [updated] = await tx
    .update(documentRenders)
    .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: sql`now()` })
    .where(and(eq(documentRenders.id, row.id), inArray(documentRenders.status, ACTIVE)))
    .returning({ id: documentRenders.id })
  if (!updated) return
  if (row.kind === 'inspect') {
    await tx
      .update(templates)
      .set({ inspectStatus: 'failed', inspectError: message.slice(0, 1000) })
      .where(eq(templates.id, row.subjectId))
  }
  const subject = await loadSubject(tx, row.subjectId)
  if (!subject) return
  await publishEvent(tx, systemCtx('documents.render', { initiatorId: row.requestedBy }), {
    type: 'document.render_finished',
    object: { id: subject.id, type: subject.type, spaceId: subject.spaceId, title: subject.title },
    payload: {
      renderId: row.id,
      kind: row.kind,
      form: row.formKey,
      status: 'failed',
      fileId: null,
    },
  })
}

interface BuiltPlan {
  plan: DocumentRenderPlan
  target: DocumentRenderTarget | null
}

/** Файл результата печати и заполнения — под заранее выданными идентификаторами. */
function fileTarget(
  row: RenderRow,
  subject: RenderSubject,
  fileName: string,
  contentType: string,
): DocumentRenderTarget {
  const ids = row.target as { fileId?: string; versionId?: string }
  if (!ids.fileId || !ids.versionId) throw errors.internal('У рендера нет файла результата')
  const extension = contentType === DOCX_MIME ? 'docx' : 'pdf'
  return {
    bucket: fileBuckets.files(),
    storageKey: fileStorageKey(subject.spaceId, ids.fileId, ids.versionId, `render.${extension}`),
    fileName,
    contentType,
  }
}

async function buildPlan(
  row: RenderRow,
  subject: RenderSubject,
  ctx: UserCtx | null,
): Promise<BuiltPlan> {
  switch (row.kind) {
    case 'print': {
      const form = row.formKey ? printForm(row.formKey) : null
      if (!form || !ctx) throw errors.conflict('Печатная форма недоступна')
      const pc = await printContext(ctx)
      const built = await form.build(pc, subject, row.params as PrintParams)
      if (built.kind === 'html') {
        return {
          plan: {
            kind: 'html',
            html: printPage({ title: built.title, lang: pc.locale, body: built.body }),
            title: built.title,
            orientation: built.orientation ?? 'portrait',
            footer: built.footer ?? '',
            labels: { page: pc.t('documents.print.page'), of: pc.t('documents.print.of') },
          },
          target: fileTarget(row, subject, built.fileName, PDF_MIME),
        }
      }
      return {
        plan: { kind: 'overlay', source: built.source, html: built.html, pages: built.pages },
        target: fileTarget(row, subject, built.fileName, PDF_MIME),
      }
    }
    case 'fill': {
      if (!ctx) throw errors.conflict('Заказчик недоступен')
      const template = await loadTemplate(db(), row.formKey ?? '')
      const brief = template?.fileId
        ? (await fileBriefs([template.fileId])).get(template.fileId)
        : undefined
      if (!template || !brief) throw errors.conflict('Файл шаблона недоступен')
      const context = await templateContext(ctx, subject.id, await orgName())
      const doc = context.doc as { subject?: string }
      return {
        plan: {
          kind: 'docx',
          template: { bucket: fileBuckets.files(), storageKey: brief.storageKey },
          context,
        },
        target: fileTarget(
          row,
          subject,
          safeFileName(doc.subject?.trim() || template.name, 'docx'),
          DOCX_MIME,
        ),
      }
    }
    case 'inspect': {
      const template = await loadTemplate(db(), subject.id)
      const brief = template?.fileId
        ? (await fileBriefs([template.fileId])).get(template.fileId)
        : undefined
      if (!brief) throw errors.conflict('У шаблона нет файла')
      return {
        plan: {
          kind: 'inspect',
          template: { bucket: fileBuckets.files(), storageKey: brief.storageKey },
        },
        target: null,
      }
    }
    case 'watermark': {
      if (!ctx) throw errors.conflict('Заказчик недоступен')
      const level = await watermarkLevel(subject.id)
      const brief = (await fileBriefs([subject.id])).get(subject.id)
      if (!level || !brief)
        throw errors.conflict('Копия с водяным знаком не нужна: у файла нет грифа')
      const t = createTranslator(ctx.locale)
      const fileName = safeFileName(
        `${baseName(brief.name)} (${t('documents.watermark.suffix')})`,
        'pdf',
      )
      return {
        plan: {
          kind: 'overlay',
          source: {
            bucket: fileBuckets.files(),
            storageKey: brief.storageKey,
            name: brief.name,
            mime: brief.mime,
          },
          html: watermarkOverlay(ctx.locale, watermarkLines(ctx, level)),
          pages: 'all',
        },
        target: {
          bucket: buckets.exports(),
          storageKey: `documents/watermarks/${row.id}/copy.pdf`,
          fileName,
          contentType: PDF_MIME,
        },
      }
    }
    default:
      throw errors.internal(`Неизвестный вид рендера ${row.kind}`)
  }
}

/**
 * Рендеры модуля документов (ADR-0085): печатные формы, штампы, заполнение и
 * разбор шаблонов, копии с водяным знаком. Заказ — строка и задание движка в
 * одной транзакции; план движок берёт в момент рендера, права и допуск
 * заказчика проверяются тогда же; результат — файл, прикреплённый к объекту
 * (печать, заполнение), список плейсхолдеров (разбор) или временная копия в
 * бакете выгрузок (водяной знак).
 */
export const DocumentRenders = {
  /** Печатные формы объекта для смотрящего — с причиной, если форма недоступна. */
  async forms(ctx: UserCtx, subjectId: string): Promise<PrintFormInfo[]> {
    await authorize(ctx, 'view', subjectId)
    const subject = await loadSubject(db(), subjectId)
    if (!subject) throw errors.notFound()
    const listed = await listedForms(subject)
    const forms = printFormsFor(subject.type).filter((form) => formAllowed(form, subject, listed))
    return Promise.all(
      forms.map(async (form) => {
        const reasonKey = form.unavailable ? await form.unavailable(subject) : null
        return {
          key: form.key,
          labelKey: form.labelKey,
          subjectType: form.subjectType,
          params: [...(form.params ?? [])],
          available: reasonKey === null,
          reasonKey,
        }
      }),
    )
  },

  /** Заказ печати: форма объекта, параметры; результат — PDF, прикреплённый к объекту. */
  async requestPrint(ctx: UserCtx, input: PrintRequestInput): Promise<string> {
    await authorize(ctx, 'view', input.subjectId)
    const subject = await loadSubject(db(), input.subjectId)
    if (!subject) throw errors.notFound()
    const form = printForm(input.form)
    if (!form || !formAllowed(form, subject, await listedForms(subject))) {
      throw errors.validation('Печатная форма недоступна', [{ path: 'form', message: 'form' }])
    }
    const params: PrintParams = {}
    if (form.params?.includes('period')) {
      const period = input.params.period
      if (!period) {
        throw errors.validation('Укажите период', [{ path: 'params.period', message: 'required' }])
      }
      if (periodDays(period) > PRINT_PERIOD_MAX_DAYS) {
        throw errors.validation('Период реестра — не больше года', [
          { path: 'params.period', message: 'too_long' },
        ])
      }
      params.period = period
    }
    const reason = form.unavailable ? await form.unavailable(subject) : null
    if (reason) throw errors.conflict(createTranslator(ctx.locale)(reason), { reason })

    return db().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`document.print:${subject.id}:${ctx.userId}`}))`,
      )
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
      const [pending] = await tx
        .select({ id: documentRenders.id })
        .from(documentRenders)
        .where(
          and(
            eq(documentRenders.subjectId, subject.id),
            eq(documentRenders.kind, 'print'),
            eq(documentRenders.formKey, form.key),
            eq(documentRenders.requestedBy, ctx.userId),
            inArray(documentRenders.status, ACTIVE),
            gte(documentRenders.createdAt, since),
            sql`${documentRenders.params} = ${JSON.stringify(params)}::jsonb`,
          ),
        )
        .limit(1)
      if (pending) return pending.id
      const id = await enqueueRender(tx, ctx, {
        kind: 'print',
        subject,
        formKey: form.key,
        params: params as Record<string, unknown>,
        requestedBy: ctx.userId,
        withFile: true,
      })
      // Печать объекта с грифом — выгрузка содержания: в аудит (08-documents.md §13)
      if (isRedacted(subject.confidentiality)) {
        await audit(
          ctx,
          {
            action: AUDIT_ACTIONS.documentPrinted,
            objectId: subject.id,
            objectType: subject.type,
            severity: 'notice',
            details: { form: form.key, renderId: id, confidentiality: subject.confidentiality },
          },
          tx,
        )
      }
      return id
    })
  },

  /**
   * Штамп регистрации — сам, как только есть номер и PDF-представление текущей
   * версии (тип документа со штампом в `printForms`); один на регистрацию и версию.
   */
  async scheduleStamp(documentId: string, actorId: string | null): Promise<string | null> {
    const subject = await loadSubject(db(), documentId)
    if (subject?.type !== 'document') return null
    const listed = await listedForms(subject)
    const form = printForm('registration_stamp')
    if (!form || !listed?.has(form.key)) return null
    if (form.unavailable && (await form.unavailable(subject))) return null
    const row = await DocumentService.load(db(), documentId)
    if (!row?.regNumber || !row.currentVersionId) return null
    const registration = await DocumentService.registration(documentId)
    const requestedBy = actorId ?? registration?.registeredBy?.id ?? null
    if (!requestedBy) return null
    const dedupeKey = `stamp:${documentId}:${row.currentVersionId}:${row.regNumber}`
    return db().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dedupeKey}))`)
      const [existing] = await tx
        .select({ id: documentRenders.id })
        .from(documentRenders)
        .where(eq(documentRenders.dedupeKey, dedupeKey))
        .limit(1)
      if (existing) return null
      return enqueueRender(tx, systemCtx('documents.stamp', { initiatorId: requestedBy }), {
        kind: 'print',
        subject,
        formKey: form.key,
        requestedBy,
        withFile: true,
        dedupeKey,
      })
    })
  },

  /**
   * Копия файла с водяным знаком (гриф от «конфиденциально»): PDF с именем
   * смотрящего и временем на каждом листе, во временном бакете выгрузок.
   */
  async requestWatermark(ctx: UserCtx, fileId: string): Promise<string> {
    await authorize(ctx, 'download', fileId)
    const subject = await loadSubject(db(), fileId)
    if (subject?.type !== 'file') throw errors.notFound('Файл')
    const level = await watermarkLevel(fileId)
    if (!level) throw errors.conflict('У файла нет грифа — он скачивается как есть')
    return db().transaction(async (tx) => {
      const id = await enqueueRender(tx, ctx, {
        kind: 'watermark',
        subject,
        formKey: fileId,
        requestedBy: ctx.userId,
      })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.documentFileExported,
          objectId: fileId,
          objectType: 'file',
          severity: 'notice',
          details: { renderId: id, confidentiality: level, watermark: true },
        },
        tx,
      )
      return id
    })
  },

  async get(ctx: UserCtx, id: string): Promise<DocumentRenderRecord> {
    const row = await loadRow(db(), id)
    // Копия с водяным знаком — личная: чужая не раскрывается
    if (!row || (row.kind === 'watermark' && row.requestedBy !== ctx.userId)) {
      throw errors.notFound('Рендер')
    }
    await authorize(ctx, 'view', row.subjectId)
    const [record] = await toRecords([row])
    if (!record) throw errors.notFound('Рендер')
    return record
  },

  /** Печатные формы и заполнения объекта — последние сверху. */
  async list(ctx: UserCtx, subjectId: string): Promise<DocumentRenderRecord[]> {
    await authorize(ctx, 'view', subjectId)
    const rows = await db()
      .select()
      .from(documentRenders)
      .where(
        and(
          eq(documentRenders.subjectId, subjectId),
          inArray(documentRenders.kind, ['print', 'fill']),
        ),
      )
      .orderBy(desc(documentRenders.createdAt))
      .limit(50)
    return toRecords(rows)
  },

  /** Ссылка на готовую копию с водяным знаком — только заказчику, пока он видит файл. */
  async download(ctx: UserCtx, id: string): Promise<DocumentRenderDownload> {
    const row = await loadRow(db(), id)
    if (row?.kind !== 'watermark' || row.requestedBy !== ctx.userId) {
      throw errors.notFound('Копия')
    }
    await authorize(ctx, 'download', row.subjectId)
    if (row.status !== 'ready') throw errors.conflict('Копия ещё готовится')
    const target = row.target as { storageKey?: string; fileName?: string }
    if (!target.storageKey || !target.fileName) throw errors.notFound('Копия')
    return {
      url: await signedGetUrl(target.storageKey, {
        bucket: buckets.exports(),
        filename: target.fileName,
      }),
      name: target.fileName,
    }
  },

  // ─── Движок ──────────────────────────────────────────────────────────────

  /**
   * Движок начинает рендер: план с правами заказчика на этот момент. Нет
   * доступа, объект удалён, форма больше недоступна — рендер не выполняется.
   */
  async engineStart(id: string): Promise<DocumentRenderStart> {
    const row = await loadRow(db(), id)
    if (!row || !ACTIVE.includes(row.status as DocumentRenderStatus)) {
      return { status: 'skip', reason: 'finished' }
    }
    const skip = async (reason: string, message: string): Promise<DocumentRenderStart> => {
      await db().transaction((tx) => fail(tx, row, message))
      return { status: 'skip', reason }
    }
    const subject = await loadSubject(db(), row.subjectId)
    if (!subject) return skip('no_subject', 'Объект удалён')
    // Разбор шаблона — служебное действие; остальное — с правами заказчика
    let ctx: UserCtx | null = null
    if (row.kind !== 'inspect') {
      ctx = row.requestedBy ? await buildUserCtxFor(row.requestedBy) : null
      if (!ctx) return skip('no_user', 'Заказчик недоступен')
      const action =
        row.kind === 'fill' ? 'add_version' : row.kind === 'watermark' ? 'download' : 'view'
      const decision = await authorize(ctx, action, subject.id, { soft: true })
      if (!decision.allowed) return skip('no_access', 'Нет доступа к объекту')
    }
    let built: BuiltPlan
    try {
      built = await buildPlan(row, subject, ctx)
    } catch (error) {
      if (error instanceof AppError) return skip('unavailable', error.message)
      throw error
    }
    await db()
      .update(documentRenders)
      .set({
        status: 'running',
        attempts: sql`${documentRenders.attempts} + 1`,
        startedAt: sql`now()`,
        error: null,
        target: {
          ...(row.target as Record<string, string>),
          ...(built.target
            ? {
                bucket: built.target.bucket,
                storageKey: built.target.storageKey,
                fileName: built.target.fileName,
                contentType: built.target.contentType,
              }
            : {}),
        },
      })
      .where(eq(documentRenders.id, id))
    return { status: 'render', plan: built.plan, target: built.target }
  },

  /**
   * Движок сообщил результат: файл печати и заполнения становится вложением
   * объекта (заполнение — ещё и версией документа), разбор — плейсхолдерами
   * шаблона. Ключ результата — тот, что выдал `engineStart`, не из отчёта.
   */
  async engineDone(id: string, result: DocumentRenderResult): Promise<{ stale: boolean }> {
    return db().transaction(async (tx) => {
      const row = await loadRow(tx, id, true)
      if (row?.status !== 'running') return { stale: true }
      if (result.status === 'failed') {
        await fail(tx, row, result.error ?? 'Рендер не удался')
        return { stale: false }
      }
      const subject = await loadSubject(tx, row.subjectId)
      if (!subject) {
        await fail(tx, row, 'Объект удалён')
        return { stale: false }
      }
      const target = row.target as Record<string, string | undefined>
      const sys = systemCtx('documents.render', { initiatorId: row.requestedBy })
      let fileId: string | null = null
      if (row.kind === 'print' || row.kind === 'fill') {
        if (!target.fileId || !target.versionId || !target.storageKey || !target.fileName) {
          await fail(tx, row, 'Нет файла результата')
          return { stale: false }
        }
        if (row.kind === 'fill') {
          const doc = await DocumentService.load(tx, subject.id)
          if (!doc || isDocumentClosed(doc.status as DocumentStatus)) {
            await fail(tx, row, 'Документ закрыт — новую версию не добавить')
            return { stale: false }
          }
        }
        fileId = await registerGeneratedFile(tx, sys, {
          fileId: target.fileId,
          versionId: target.versionId,
          spaceId: subject.spaceId,
          name: target.fileName,
          mime: target.contentType ?? PDF_MIME,
          size: result.size ?? 0,
          storageKey: target.storageKey,
          checksum: null,
          attachToObjectId: subject.id,
        })
        if (row.kind === 'fill') {
          const template = await loadTemplate(tx, row.formKey ?? '')
          const requester = row.requestedBy ? await buildUserCtxFor(row.requestedBy) : null
          const t = createTranslator(requester?.locale ?? 'ru')
          await DocumentVersionService.add(tx, sys, subject.id, {
            mainFileId: fileId,
            attachmentIds: [],
            note: t('documents.templates.versionNote', { name: template?.name ?? '' }),
          })
        }
      } else if (row.kind === 'inspect') {
        const template = await loadTemplate(tx, subject.id)
        const type = template?.typeId ? await DocumentTypeService.load(tx, template.typeId) : null
        const { known, unknown } = classifyPlaceholders(
          result.placeholders ?? [],
          type ? type.cardSchema.fields.map((field) => field.key) : null,
        )
        await tx
          .update(templates)
          .set({
            placeholders: [...known, ...unknown].sort(),
            unknownPlaceholders: unknown,
            inspectStatus: 'ready',
            inspectError: null,
          })
          .where(eq(templates.id, subject.id))
      }
      await tx
        .update(documentRenders)
        .set({
          status: 'ready',
          fileId,
          pages: result.pages,
          size: result.size,
          error: null,
          finishedAt: sql`now()`,
        })
        .where(eq(documentRenders.id, id))
      await publishEvent(tx, sys, {
        type: 'document.render_finished',
        object: {
          id: subject.id,
          type: subject.type,
          spaceId: subject.spaceId,
          title: subject.title,
        },
        payload: { renderId: id, kind: row.kind, form: row.formKey, status: 'ready', fileId },
      })
      return { stale: false }
    })
  },

  /** Окончательный сбой задания движка: рендер не остаётся «в работе» навсегда. */
  async failById(id: string, message: string): Promise<void> {
    await db().transaction(async (tx) => {
      const row = await loadRow(tx, id, true)
      if (row) await fail(tx, row, message)
    })
  },
}
