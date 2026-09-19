import {
  classifyPlaceholders,
  type DocumentFillInput,
  type DocumentFromTemplateInput,
  type DocumentStatus,
  DocumentTemplateCreateInput,
  type DocumentTemplateFileInput,
  type DocumentTemplateListQuery,
  type DocumentTemplateRecord,
  type DocumentTemplateUpdateInput,
  isDocumentClosed,
  type TemplateDefaults,
  type TemplateInspectStatus,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { fileBriefs } from '~/modules/files/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documentTypes, objects, templates } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { DocumentService } from './document-service.js'
import { enqueueRender, loadSubject } from './render-queue.js'
import { documentsSpaceId } from './space.js'
import { DocumentTypeService } from './type-service.js'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const COLUMNS = {
  id: templates.id,
  name: templates.name,
  description: templates.description,
  typeId: templates.documentTypeId,
  fileId: templates.fileId,
  defaults: templates.defaults,
  placeholders: templates.placeholders,
  unknownPlaceholders: templates.unknownPlaceholders,
  inspectStatus: templates.inspectStatus,
  inspectError: templates.inspectError,
  isActive: templates.isActive,
  spaceId: objects.spaceId,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function selectTemplates(executor: Executor) {
  return executor.select(COLUMNS).from(templates).innerJoin(objects, eq(objects.id, templates.id))
}

export type TemplateRow = Awaited<ReturnType<typeof selectTemplates>>[number]

export async function loadTemplate(executor: Executor, id: string): Promise<TemplateRow | null> {
  const [row] = await selectTemplates(executor)
    .where(and(eq(templates.id, id), isNull(objects.deletedAt)))
    .limit(1)
  return row ?? null
}

/** Поля карточки по умолчанию проверяются по схеме типа шаблона — при создании документа. */
function defaultsOf(row: TemplateRow): TemplateDefaults {
  return row.defaults as TemplateDefaults
}

async function assertType(executor: Executor, typeId: string | null): Promise<void> {
  if (!typeId) return
  const type = await DocumentTypeService.load(executor, typeId)
  if (!type)
    throw errors.validation('Тип документа не найден', [{ path: 'typeId', message: 'type' }])
}

/**
 * Шаблоны DOCX (08-documents.md §8, ADR-0085) — справочник документооборота:
 * объект реестра `template` в системном пространстве, открыт всем
 * сотрудникам на просмотр (`everyone: view`), ведут его владельцы способности
 * `documents.journals.manage` (политика типа), как типы и журналы.
 */
export const DocumentTemplateService = {
  async list(ctx: UserCtx, query: DocumentTemplateListQuery): Promise<DocumentTemplateRecord[]> {
    const rows = await selectTemplates(db())
      .where(
        and(
          visibleObjectsSql(ctx, 'template'),
          isNull(objects.deletedAt),
          ...(query.includeInactive ? [] : [eq(templates.isActive, true)]),
          // Шаблон без типа подходит любому типу
          ...(query.typeId
            ? [or(eq(templates.documentTypeId, query.typeId), isNull(templates.documentTypeId))]
            : []),
        ),
      )
      .orderBy(asc(templates.name))
    return DocumentTemplateService.records(ctx, rows)
  },

  async get(ctx: UserCtx, id: string): Promise<DocumentTemplateRecord> {
    await authorize(ctx, 'view', id)
    const row = await loadTemplate(db(), id)
    if (!row) throw errors.notFound('Шаблон')
    const [record] = await DocumentTemplateService.records(ctx, [row])
    if (!record) throw errors.notFound('Шаблон')
    return record
  },

  async records(ctx: UserCtx, rows: TemplateRow[]): Promise<DocumentTemplateRecord[]> {
    const typeIds = [...new Set(rows.map((row) => row.typeId).filter((v): v is string => !!v))]
    const [types, briefs] = await Promise.all([
      typeIds.length
        ? db()
            .select({ id: documentTypes.id, key: documentTypes.key, name: documentTypes.name })
            .from(documentTypes)
            .where(inArray(documentTypes.id, typeIds))
        : Promise.resolve([]),
      fileBriefs(rows.map((row) => row.fileId).filter((v): v is string => !!v)),
    ])
    const typeById = new Map(types.map((type) => [type.id, type]))
    const result: DocumentTemplateRecord[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'manage', row.id, { soft: true })
      const brief = row.fileId ? briefs.get(row.fileId) : undefined
      const type = row.typeId ? typeById.get(row.typeId) : undefined
      result.push({
        id: row.id,
        spaceId: row.spaceId ?? '',
        name: row.name,
        description: row.description,
        type: type ? { id: type.id, key: type.key, name: type.name } : null,
        file: brief ? { id: brief.id, name: brief.name, mime: brief.mime, size: brief.size } : null,
        defaults: defaultsOf(row),
        placeholders: row.placeholders,
        unknownPlaceholders: row.unknownPlaceholders,
        inspectStatus: row.inspectStatus as TemplateInspectStatus,
        inspectError: row.inspectError,
        isActive: row.isActive,
        canManage: decision.allowed,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    return result
  },

  async create(tx: Executor, ctx: Ctx, raw: DocumentTemplateCreateInput): Promise<string> {
    requireCapability(ctx, 'documents.journals.manage')
    const input = DocumentTemplateCreateInput.parse(raw)
    await assertType(tx, input.typeId)
    const spaceId = await documentsSpaceId(tx)
    // Справочник принадлежит установке, а не автору: владельца нет
    const object = await ObjectService.create(tx, ctx, {
      type: 'template',
      spaceId,
      title: input.name,
      ownerId: null,
      meta: { typeId: input.typeId },
    })
    await tx.insert(templates).values({
      id: object.id,
      name: input.name,
      description: input.description,
      documentTypeId: input.typeId,
      defaults: input.defaults,
    })
    await grantAccess(
      tx,
      ctx,
      object.id,
      [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
      { quiet: true },
    )
    const type = input.typeId ? await DocumentTypeService.load(tx, input.typeId) : null
    await publishEvent(tx, ctx, {
      type: 'template.created',
      object: { id: object.id, type: 'template', spaceId, title: input.name },
      payload: { name: input.name, typeKey: type?.key ?? null },
    })
    return object.id
  },

  async update(
    tx: Executor,
    ctx: Ctx,
    id: string,
    patch: DocumentTemplateUpdateInput,
  ): Promise<void> {
    await authorize(ctx, 'manage', id)
    const current = await loadTemplate(tx, id)
    if (!current) throw errors.notFound('Шаблон')
    if (patch.typeId !== undefined) await assertType(tx, patch.typeId)
    const values: Record<string, unknown> = {}
    const changed: string[] = []
    const set = (key: string, value: unknown) => {
      values[key] = value
      changed.push(key)
    }
    if (patch.name !== undefined) set('name', patch.name)
    if (patch.description !== undefined) set('description', patch.description)
    if (patch.typeId !== undefined) set('documentTypeId', patch.typeId)
    if (patch.defaults !== undefined) set('defaults', patch.defaults)
    if (patch.isActive !== undefined) set('isActive', patch.isActive)
    if (changed.length === 0) return
    await tx.update(templates).set(values).where(eq(templates.id, id))
    const object = patch.name
      ? await ObjectService.update(tx, ctx, id, { title: patch.name })
      : await ObjectService.get(id, tx)
    await publishEvent(tx, ctx, {
      type: 'template.updated',
      object: {
        id,
        type: 'template',
        spaceId: object?.spaceId ?? null,
        title: object?.title ?? current.name,
      },
      payload: { changed },
    })
    // Сменился тип — поля карточки другие: плейсхолдеры разбираются заново
    if (patch.typeId !== undefined && current.fileId && patch.typeId !== current.typeId) {
      await DocumentTemplateService.inspect(tx, ctx, id)
    }
  },

  /**
   * Файл шаблона: DOCX, загруженный вложением шаблона. Плейсхолдеры разбирает
   * движок (`inspect`), до разбора шаблон в «Создать по шаблону» не предлагается.
   */
  async setFile(
    tx: Executor,
    ctx: Ctx,
    id: string,
    input: DocumentTemplateFileInput,
    options: { placeholders?: readonly string[] } = {},
  ): Promise<void> {
    await authorize(ctx, 'manage', id)
    const current = await loadTemplate(tx, id)
    if (!current) throw errors.notFound('Шаблон')
    const attached = new Set(await LinkService.attachments(id, tx))
    if (!attached.has(input.fileId)) {
      throw errors.validation('Файл не прикреплён к шаблону', [
        { path: 'fileId', message: 'not_attached' },
      ])
    }
    const brief = (await fileBriefs([input.fileId], tx)).get(input.fileId)
    if (!brief) throw errors.notFound('Файл')
    const isDocx = brief.mime === DOCX_MIME || brief.name.toLowerCase().endsWith('.docx')
    if (!isDocx) {
      throw errors.validation('Шаблон — файл Word (.docx)', [
        { path: 'fileId', message: 'not_docx' },
      ])
    }
    await tx
      .update(templates)
      .set({ fileId: input.fileId, placeholders: [], unknownPlaceholders: [], inspectError: null })
      .where(eq(templates.id, id))
    await publishEvent(tx, ctx, {
      type: 'template.updated',
      object: { id, type: 'template', spaceId: current.spaceId, title: current.name },
      payload: { changed: ['fileId'] },
    })
    // Плейсхолдеры известны заранее (стартовый шаблон сида) — без разбора движком
    if (options.placeholders) {
      const type = current.typeId ? await DocumentTypeService.load(tx, current.typeId) : null
      const { known, unknown } = classifyPlaceholders(
        options.placeholders,
        type ? type.cardSchema.fields.map((field) => field.key) : null,
      )
      await tx
        .update(templates)
        .set({
          placeholders: [...known, ...unknown].sort(),
          unknownPlaceholders: unknown,
          inspectStatus: 'ready',
        })
        .where(eq(templates.id, id))
      return
    }
    await DocumentTemplateService.inspect(tx, ctx, id)
  },

  /** Разбор шаблона движком: найденные плейсхолдеры и неизвестные контексту. */
  async inspect(tx: Executor, ctx: Ctx, id: string): Promise<string> {
    const subject = await loadSubject(tx, id)
    if (!subject) throw errors.notFound('Шаблон')
    await tx
      .update(templates)
      .set({ inspectStatus: 'pending', inspectError: null })
      .where(eq(templates.id, id))
    return enqueueRender(tx, ctx, {
      kind: 'inspect',
      subject,
      formKey: id,
      requestedBy: ctx.kind === 'user' ? ctx.userId : ctx.initiatorId,
    })
  },

  /**
   * «Создать по шаблону»: черновик с карточкой шаблона (тема, содержание, поля
   * по умолчанию) и введённой; первую версию строит движок заполнением шаблона.
   */
  async createDocument(
    tx: Executor,
    ctx: UserCtx,
    input: DocumentFromTemplateInput,
  ): Promise<{ id: string; renderId: string }> {
    await authorize(ctx, 'view', input.templateId)
    const template = await loadTemplate(tx, input.templateId)
    if (!template?.isActive) throw errors.notFound('Шаблон')
    if (!template.fileId || template.inspectStatus !== 'ready') {
      throw errors.conflict('Шаблон ещё не готов: файл не загружен или не разобран')
    }
    const typeId = input.typeId ?? template.typeId
    if (!typeId) {
      throw errors.validation('Выберите тип документа', [{ path: 'typeId', message: 'required' }])
    }
    if (template.typeId && template.typeId !== typeId) {
      throw errors.validation('Шаблон другого типа документа', [
        { path: 'templateId', message: 'type_mismatch' },
      ])
    }
    const { templateId: _template, ...card } = input
    const defaults = defaultsOf(template)
    const id = await DocumentService.create(tx, ctx, {
      ...card,
      typeId,
      subject: card.subject?.trim() ? card.subject : defaults.subject,
      summary: card.summary ?? defaults.summary ?? null,
      fields: { ...(defaults.fields ?? {}), ...(card.fields ?? {}) },
    })
    const renderId = await DocumentTemplateService.enqueueFill(tx, ctx, id, template.id)
    return { id, renderId }
  },

  /** Перезаполнить документ по шаблону из текущей карточки — новая версия. */
  async fill(tx: Executor, ctx: UserCtx, documentId: string, input: DocumentFillInput) {
    await authorize(ctx, 'add_version', documentId)
    await authorize(ctx, 'view', input.templateId)
    const template = await loadTemplate(tx, input.templateId)
    if (!template?.isActive || !template.fileId || template.inspectStatus !== 'ready') {
      throw errors.conflict('Шаблон ещё не готов: файл не загружен или не разобран')
    }
    const doc = await DocumentService.load(tx, documentId)
    if (!doc) throw errors.notFound('Документ')
    if (isDocumentClosed(doc.status as DocumentStatus)) {
      throw errors.conflict('Документ закрыт — новую версию не добавить')
    }
    if (template.typeId && template.typeId !== doc.typeId) {
      throw errors.validation('Шаблон другого типа документа', [
        { path: 'templateId', message: 'type_mismatch' },
      ])
    }
    return DocumentTemplateService.enqueueFill(tx, ctx, documentId, template.id)
  },

  async enqueueFill(
    tx: Executor,
    ctx: UserCtx,
    documentId: string,
    templateId: string,
  ): Promise<string> {
    const subject = await loadSubject(tx, documentId)
    if (!subject) throw errors.notFound('Документ')
    return enqueueRender(tx, ctx, {
      kind: 'fill',
      subject,
      formKey: templateId,
      requestedBy: ctx.userId,
      withFile: true,
    })
  },

  /** Имена шаблонов для записей рендеров заполнения. */
  async names(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    const rows = await db()
      .select({ id: templates.id, name: templates.name })
      .from(templates)
      .where(inArray(templates.id, ids))
    return new Map(rows.map((row) => [row.id, row.name]))
  },

  /** Шаблон по названию — идемпотентный сид стартового набора. */
  async byName(executor: Executor, name: string): Promise<{ id: string } | null> {
    const [row] = await executor
      .select({ id: templates.id })
      .from(templates)
      .where(sql`${templates.name} = ${name}`)
      .limit(1)
    return row ?? null
  },
}
