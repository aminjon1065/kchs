import type { ObjectSummary } from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import { db } from '~/shared/db/client.js'
import {
  correspondents,
  documents,
  documentTypes,
  journals,
  objects,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { capabilityPolicy } from './domain/policies.js'
import {
  DOCUMENT_LIST_FIELDS,
  documentSearchContent,
  documentSummaries,
} from './domain/registry.js'
import { documentSubscribers } from './domain/subscribers.js'
import { DOCUMENTS_SYSTEM_DATASET } from './domain/system-dataset.js'
import { registerDocumentAssistRoutes } from './http/assist-routes.js'
import { registerDocumentRoutes } from './http/routes.js'

const LEVELS = ['view', 'comment', 'edit', 'manage', 'owner'] as const

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
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
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

  registerSystemDataset(DOCUMENTS_SYSTEM_DATASET)
}

/** Подписчики модуля — только в роли worker. */
export function registerDocumentsBackground(): void {
  for (const subscriber of documentSubscribers) registerSubscriber(subscriber)
}

export function registerDocumentsRoutes(route: RouteRegistrar): void {
  registerDocumentRoutes(route)
  registerDocumentAssistRoutes(route)
}
