import type { ObjectSummary } from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { withProcessParticipants } from '~/kernel/process/index.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import { registerCalendarProjection } from '~/modules/calendar/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { db } from '~/shared/db/client.js'
import {
  correspondents,
  documents,
  documentTypes,
  journals,
  objects,
  templates,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentAcknowledgments } from './domain/acknowledgment-service.js'
import { CaseService } from './domain/case-service.js'
import { documentControlProjection } from './domain/control-projection.js'
import { onDocumentRegistered } from './domain/document-service.js'
import { MailIntake } from './domain/mail/mail-service.js'
import { capabilityPolicy, documentPolicy } from './domain/policies.js'
import { registerBuiltinPrintForms } from './domain/print/forms/index.js'
import {
  CASE_LIST_FIELDS,
  DOCUMENT_LIST_FIELDS,
  documentSearchContent,
  documentSummaries,
} from './domain/registry.js'
import { renderSubscribers } from './domain/render-subscribers.js'
import { ResolutionService } from './domain/resolution-service.js'
import { registerDocumentProcess } from './domain/routes/provider.js'
import { documentSubscribers } from './domain/subscribers.js'
import { DOCUMENTS_SYSTEM_DATASET } from './domain/system-dataset.js'
import { registerDocumentAssistRoutes } from './http/assist-routes.js'
import { registerMailRoutes } from './http/mail-routes.js'
import { registerDocumentProcessRoutes } from './http/process-routes.js'
import { registerRenderRoutes } from './http/render-routes.js'
import { registerDocumentRoutes } from './http/routes.js'
import { registerTemplateRoutes } from './http/template-routes.js'

const LEVELS = ['view', 'comment', 'edit', 'manage', 'owner'] as const

/** После регистрации — на резолюцию по правилу типа (ADR-0084). */
async function requestResolution(tx: Executor, ctx: Ctx, documentId: string): Promise<void> {
  await ResolutionService.requestByTypeRule(tx, ctx, documentId)
}

/**
 * Дела `resolve` (ADR-0084): «Не требует исполнения» — сразу; «Наложить
 * резолюцию» выполняется формой в карточке (действие `openObject`).
 */
function registerResolutionInboxActions(): void {
  registerInboxActionHandler('resolve', async (ctx, { item, action, comment }) => {
    if (!item.objectId) throw errors.validation('Нет такого действия')
    const documentId = item.objectId
    if (action === 'no_execution') {
      await db().transaction((tx) =>
        ResolutionService.noExecution(tx, ctx, documentId, { comment: comment ?? null }),
      )
      return
    }
    throw errors.validation('Резолюция накладывается в карточке документа')
  })
}

/**
 * Типы `document`, `document_type`, `journal`, `correspondent` и системный
 * датасет «Документы» (08-documents.md, ADR-0080) — при старте в любой роли:
 * HTTP проверяет права, воркер — подписчиков.
 */
export function registerDocumentsObjectTypes(): void {
  registerObjectType({
    type: 'document',
    labelKey: 'objects.types.document',
    icon: 'document',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      add_version: { minLevel: 'edit' },
      /** Регистрация — делопроизводитель: право правки и способность. */
      register: { minLevel: 'edit', capability: 'documents.register' },
      /** Аннулирование черновика — автором (правом правки), с обоснованием. */
      cancel: { minLevel: 'edit' },
      /** Аннулирование зарегистрированного — ещё и способностью делопроизводителя. */
      cancel_registered: { minLevel: 'edit', capability: 'documents.register' },
      /** Отправить на ознакомление и напомнить (ADR-0084) — правом правки. */
      request_acknowledgment: { minLevel: 'edit', allowArchived: true },
      /** Ответ исходящим на входящий — тот, кто видит входящий (ADR-0086). */
      reply: { minLevel: 'view' },
      /** Отметка об отправке исходящего — делопроизводитель (ADR-0086). */
      dispatch: { minLevel: 'edit', capability: 'documents.register' },
      /** Подшивка исполненного документа в дело — делопроизводитель (ADR-0086). */
      file: { minLevel: 'edit', capability: 'documents.register' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    // Участник шага маршрута видит документ (и заместитель — через замещаемого);
    // пока шаг идёт — ещё и обсуждает: вопрос автору до решения (ADR-0083).
    // Заместитель «от имени» — на уровне участия замещаемого (ADR-0084)
    policy: withProcessParticipants(documentPolicy, { afterStep: 'view', activeLevel: 'comment' }),
    listFields: DOCUMENT_LIST_FIELDS,
    summary: documentSummaries,
    searchable: documentSearchContent,
    lifecycle: {
      // Зарегистрированный документ не удаляется — только аннулируется (08-documents.md §3)
      beforeTrash: async (tx, _ctx, object) => {
        const [row] = await tx
          .select({ status: documents.status })
          .from(documents)
          .where(eq(documents.id, object.id))
          .limit(1)
        if (row && row.status !== 'draft' && row.status !== 'cancelled') {
          throw errors.conflict('Документ после черновика не удаляется — только аннулируется')
        }
      },
      // Архив документа — «в дело» по номенклатуре (вторая волна), не общий архив объектов
      beforeArchive: async () => {
        throw errors.conflict('Документ передаётся в архив через дело номенклатуры')
      },
    },
  })

  registerObjectType({
    type: 'document_type',
    labelKey: 'objects.types.document_type',
    icon: 'document_type',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    // Справочник ведут владельцы способности «вести журналы»
    policy: capabilityPolicy(
      ['documents.journals.manage'],
      'manage',
      'Ведение справочников документооборота',
    ),
    summary: async (ids) => {
      const rows = await db()
        .select({
          id: documentTypes.id,
          key: documentTypes.key,
          direction: documentTypes.direction,
        })
        .from(documentTypes)
        .where(inArray(documentTypes.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          { meta: { key: row.key, direction: row.direction } } as Partial<ObjectSummary>,
        ]),
      )
    },
  })

  registerObjectType({
    type: 'journal',
    labelKey: 'objects.types.journal',
    icon: 'journal',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      /** Регистрация и резерв номеров в журнале — делопроизводитель журнала. */
      register_in: { minLevel: 'edit', capability: 'documents.register' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: true,
    moduleManaged: true,
    // Ведущий журналы управляет ими; права на документы журнала — только его ACL
    policy: capabilityPolicy(['documents.journals.manage'], 'manage', 'Ведение журналов'),
    summary: async (ids) => {
      const rows = await db()
        .select({ id: journals.id, prefix: journals.prefix, format: journals.format })
        .from(journals)
        .where(inArray(journals.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          { meta: { prefix: row.prefix, format: row.format } } as Partial<ObjectSummary>,
        ]),
      )
    },
  })

  registerObjectType({
    type: 'correspondent',
    labelKey: 'objects.types.correspondent',
    icon: 'correspondent',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    // Корреспондентов заводят и правят делопроизводители при регистрации
    policy: capabilityPolicy(
      ['documents.register', 'documents.journals.manage'],
      'edit',
      'Делопроизводство',
    ),
    summary: async (ids) => {
      const rows = await db()
        .select({ id: correspondents.id, kind: correspondents.kind })
        .from(correspondents)
        .where(inArray(correspondents.id, ids))
      return new Map(
        rows.map((row) => [row.id, { meta: { kind: row.kind } } as Partial<ObjectSummary>]),
      )
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          name: correspondents.name,
          details: correspondents.details,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
          kind: correspondents.kind,
        })
        .from(correspondents)
        .innerJoin(objects, eq(objects.id, correspondents.id))
        .where(eq(correspondents.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'correspondent',
        spaceId: row.spaceId,
        title: row.name,
        body: Object.values(row.details).join('\n').slice(0, 5000),
        ownerId: null,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { kind: row.kind },
      }
    },
  })

  registerObjectType({
    type: 'case',
    labelKey: 'objects.types.case',
    icon: 'case',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      /** Подшивать документы в дело — делопроизводитель дела (ADR-0086). */
      file_in: { minLevel: 'edit', capability: 'documents.register' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      /** Удалить можно пустое открытое дело (ошибочная запись номенклатуры). */
      delete: { minLevel: 'manage' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    // Номенклатуру ведут владельцы «вести журналы»; подшивают — записи ACL дела
    policy: capabilityPolicy(['documents.journals.manage'], 'manage', 'Ведение номенклатуры дел'),
    listFields: CASE_LIST_FIELDS,
    lifecycle: {
      beforeTrash: async (tx, _ctx, object) => CaseService.assertDeletable(tx, object.id),
      // Архив дела — своё действие «Передать в архив» с документами, не общий архив
      beforeArchive: async () => {
        throw errors.conflict('Дело передаётся в архив действием «Передать в архив»')
      },
    },
  })

  // Шаблон документа DOCX (08-documents.md §8, ADR-0085) — справочник, как типы
  registerObjectType({
    type: 'template',
    labelKey: 'objects.types.template',
    icon: 'template',
    route: (id) => `/o/${id}`,
    levels: [...LEVELS],
    actions: {
      view: { minLevel: 'view' },
      /** Файл шаблона загружается вложением шаблона. */
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    policy: capabilityPolicy(
      ['documents.journals.manage'],
      'manage',
      'Ведение справочников документооборота',
    ),
    summary: async (ids) => {
      const rows = await db()
        .select({ id: templates.id, kind: templates.kind, typeId: templates.documentTypeId })
        .from(templates)
        .where(inArray(templates.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          { meta: { kind: row.kind, typeId: row.typeId } } as Partial<ObjectSummary>,
        ]),
      )
    },
  })

  registerSystemDataset(DOCUMENTS_SYSTEM_DATASET)
  registerBuiltinPrintForms()
  // Маршруты документов на движке процессов: хуки статусов и шаг регистрации
  registerDocumentProcess()
  // Резолюции и ознакомление (ADR-0084): продолжение регистрации, дела Входящих, календарь
  onDocumentRegistered(requestResolution)
  onDocumentRegistered(DocumentAcknowledgments.onRegistered)
  registerResolutionInboxActions()
  registerCalendarProjection(documentControlProjection)
}

const MAIL_POLL_JOB = 'documents.mail-poll'
const MAIL_PURGE_JOB = 'documents.mail-purge'

/** Подписчики модуля — только в роли worker. */
export function registerDocumentsBackground(): void {
  for (const subscriber of documentSubscribers) registerSubscriber(subscriber)
  for (const subscriber of renderSubscribers) registerSubscriber(subscriber)
  registerJobHandler({
    queue: 'maintenance',
    name: MAIL_POLL_JOB,
    concurrency: 1,
    handle: async () => {
      const report = await MailIntake.poll()
      return { ...report.result, mailboxes: report.mailboxes, errors: report.errors.length }
    },
  })
  registerJobHandler({
    queue: 'maintenance',
    name: MAIL_PURGE_JOB,
    concurrency: 1,
    handle: async () => ({ deleted: await MailIntake.purge() }),
  })
}

export function registerDocumentsRoutes(route: RouteRegistrar): void {
  registerDocumentRoutes(route)
  registerDocumentAssistRoutes(route)
  registerDocumentProcessRoutes(route)
  registerRenderRoutes(route)
  registerTemplateRoutes(route)
  // Очередь «Из почты» (ADR-0113)
  registerMailRoutes(route)
}

/**
 * Опрос ящиков канцелярии (ADR-0113). Расписание одно на установку и тикает
 * раз в пять минут; свой период (`pollMinutes`) у каждого ящика проверяется
 * внутри задания — второго планировщика для этого не нужно (ADR-0096).
 * Очистка очереди «Из почты» по сроку хранения — раз в сутки ночью (ADR-0136).
 */
export function scheduleDocumentsJobs(): void {
  declareSchedule({
    queue: 'maintenance',
    name: MAIL_POLL_JOB,
    pattern: '*/5 * * * *',
    labelKey: 'schedules.jobs.documentsMailPoll',
  })
  declareSchedule({
    queue: 'maintenance',
    name: MAIL_PURGE_JOB,
    pattern: '25 3 * * *',
    labelKey: 'schedules.jobs.documentsMailPurge',
  })
}
