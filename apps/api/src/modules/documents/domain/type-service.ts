import {
  type Confidentiality,
  type DocumentCardSchema,
  type DocumentDirection,
  DocumentTypeCreateInput,
  type DocumentTypeRecord,
  DocumentTypeSettings,
  type DocumentTypeUpdateInput,
  type FieldDef,
  type LangText,
  parseConfidentiality,
} from '@kchs/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documentTypes, journals, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { documentsSpaceId } from './space.js'

/** Типы полей, которые карточка документа не поддерживает: вычисляемые и служебные. */
const UNSUPPORTED_CARD_TYPES = new Set(['formula', 'lookup', 'rollup', 'signature', 'geometry'])

/** Строка типа документа — то, что нужно карточке, регистрации и списку. */
export interface DocumentTypeRow {
  id: string
  key: string
  name: LangText
  direction: DocumentDirection
  cardSchema: DocumentCardSchema
  numbering: { journalId: string | null; format: string | null }
  defaultRouteKey: string | null
  retentionYears: number | null
  confidentialityAllowed: Confidentiality[]
  defaultConfidentiality: Confidentiality
  printForms: string[]
  settings: DocumentTypeSettings
  isActive: boolean
  createdAt: string
  updatedAt: string
}

const COLUMNS = {
  id: documentTypes.id,
  key: documentTypes.key,
  name: documentTypes.name,
  direction: documentTypes.direction,
  cardSchema: documentTypes.cardSchema,
  numbering: documentTypes.numbering,
  defaultRouteKey: documentTypes.defaultRouteKey,
  retentionYears: documentTypes.retentionYears,
  confidentialityAllowed: documentTypes.confidentialityAllowed,
  defaultConfidentiality: documentTypes.defaultConfidentiality,
  printForms: documentTypes.printForms,
  settings: documentTypes.settings,
  isActive: documentTypes.isActive,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function toRow(raw: {
  id: string
  key: string
  name: LangText
  direction: string
  cardSchema: { fields?: unknown[] }
  numbering: { journalId?: string | null; format?: string | null }
  defaultRouteKey: string | null
  retentionYears: number | null
  confidentialityAllowed: string[]
  defaultConfidentiality: string
  printForms: string[]
  settings: Record<string, unknown>
  isActive: boolean
  createdAt: string
  updatedAt: string
}): DocumentTypeRow {
  return {
    id: raw.id,
    key: raw.key,
    name: raw.name,
    direction: raw.direction as DocumentDirection,
    cardSchema: { fields: (raw.cardSchema.fields ?? []) as FieldDef[] },
    numbering: {
      journalId: raw.numbering.journalId ?? null,
      format: raw.numbering.format ?? null,
    },
    defaultRouteKey: raw.defaultRouteKey,
    retentionYears: raw.retentionYears,
    confidentialityAllowed: raw.confidentialityAllowed.map((value) =>
      parseConfidentiality(value, 'internal'),
    ),
    defaultConfidentiality: parseConfidentiality(raw.defaultConfidentiality, 'internal'),
    printForms: raw.printForms,
    settings: DocumentTypeSettings.parse(raw.settings),
    isActive: raw.isActive,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

function selectTypes(executor: Executor) {
  return executor
    .select(COLUMNS)
    .from(documentTypes)
    .innerJoin(objects, eq(objects.id, documentTypes.id))
}

/** Карточка типа: уникальные ключи полей, поддерживаемые типы полей. */
function assertCardSchema(schema: DocumentCardSchema): void {
  const keys = new Set<string>()
  for (const field of schema.fields) {
    if (keys.has(field.key)) {
      throw errors.validation(`Поле «${field.key}» повторяется в карточке`, [
        { path: 'cardSchema.fields', message: 'duplicate_key' },
      ])
    }
    keys.add(field.key)
    if (UNSUPPORTED_CARD_TYPES.has(field.type)) {
      throw errors.validation(`Тип поля «${field.type}» недоступен в карточке документа`, [
        { path: 'cardSchema.fields', message: 'unsupported_type' },
      ])
    }
  }
}

function assertConfidentiality(allowed: Confidentiality[], fallback: Confidentiality): void {
  if (!allowed.includes(fallback)) {
    throw errors.validation('Гриф по умолчанию должен быть среди допустимых', [
      { path: 'defaultConfidentiality', message: 'not_allowed' },
    ])
  }
}

async function assertJournal(executor: Executor, journalId: string | null): Promise<void> {
  if (!journalId) return
  const [row] = await executor
    .select({ id: journals.id })
    .from(journals)
    .where(eq(journals.id, journalId))
    .limit(1)
  if (!row) {
    throw errors.validation('Журнал не найден', [
      { path: 'numbering.journalId', message: 'journal' },
    ])
  }
}

/**
 * Типы документов (08-documents.md §2): справочник открыт всем сотрудникам
 * (выдача `everyone: view`), ведут его владельцы способности
 * `documents.journals.manage` — производный уровень `manage` политики типа.
 */
export const DocumentTypeService = {
  async load(executor: Executor, id: string): Promise<DocumentTypeRow | null> {
    const [raw] = await selectTypes(executor).where(eq(documentTypes.id, id)).limit(1)
    return raw ? toRow(raw) : null
  },

  async loadMany(executor: Executor, ids: string[]): Promise<Map<string, DocumentTypeRow>> {
    if (ids.length === 0) return new Map()
    const rows = await selectTypes(executor).where(inArray(documentTypes.id, ids))
    return new Map(rows.map((raw) => [raw.id, toRow(raw)]))
  },

  async byKey(executor: Executor, key: string): Promise<DocumentTypeRow | null> {
    const [raw] = await selectTypes(executor).where(eq(documentTypes.key, key)).limit(1)
    return raw ? toRow(raw) : null
  },

  async list(ctx: UserCtx, options: { includeInactive?: boolean } = {}) {
    const rows = await selectTypes(db())
      .where(
        and(
          visibleObjectsSql(ctx, 'document_type'),
          sql`${objects.deletedAt} IS NULL`,
          ...(options.includeInactive ? [] : [eq(documentTypes.isActive, true)]),
        ),
      )
      .orderBy(asc(sql`${documentTypes.name}->>'ru'`))
    return DocumentTypeService.records(ctx, rows.map(toRow))
  },

  async get(ctx: UserCtx, id: string): Promise<DocumentTypeRecord> {
    await authorize(ctx, 'view', id)
    const row = await DocumentTypeService.load(db(), id)
    if (!row) throw errors.notFound('Тип документа')
    const [record] = await DocumentTypeService.records(ctx, [row])
    if (!record) throw errors.notFound('Тип документа')
    return record
  },

  async records(ctx: UserCtx, rows: DocumentTypeRow[]): Promise<DocumentTypeRecord[]> {
    const journalIds = [
      ...new Set(rows.map((row) => row.numbering.journalId).filter((v): v is string => !!v)),
    ]
    const names = journalIds.length
      ? new Map(
          (
            await db()
              .select({ id: journals.id, name: journals.name })
              .from(journals)
              .where(inArray(journals.id, journalIds))
          ).map((row) => [row.id, row.name]),
        )
      : new Map<string, string>()
    const result: DocumentTypeRecord[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'manage', row.id, { soft: true })
      result.push({
        ...row,
        journalName: row.numbering.journalId ? (names.get(row.numbering.journalId) ?? null) : null,
        canManage: decision.allowed,
      })
    }
    return result
  },

  async create(tx: Executor, ctx: Ctx, raw: DocumentTypeCreateInput): Promise<string> {
    requireCapability(ctx, 'documents.journals.manage')
    const input = DocumentTypeCreateInput.parse(raw)
    assertCardSchema(input.cardSchema)
    assertConfidentiality(input.confidentialityAllowed, input.defaultConfidentiality)
    await assertJournal(tx, input.numbering.journalId)
    const [taken] = await tx
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.key, input.key))
      .limit(1)
    if (taken) throw errors.conflict('Тип документа с таким ключом уже есть', { key: input.key })

    const spaceId = await documentsSpaceId(tx)
    // Справочник принадлежит установке, а не автору: владельца нет
    const object = await ObjectService.create(tx, ctx, {
      type: 'document_type',
      spaceId,
      title: input.name.ru,
      subtitle: input.key,
      ownerId: null,
      meta: { key: input.key, direction: input.direction },
    })
    await tx.insert(documentTypes).values({
      id: object.id,
      key: input.key,
      name: input.name,
      direction: input.direction,
      cardSchema: input.cardSchema,
      numbering: input.numbering,
      defaultRouteKey: input.defaultRouteKey,
      retentionYears: input.retentionYears,
      confidentialityAllowed: input.confidentialityAllowed,
      defaultConfidentiality: input.defaultConfidentiality,
      printForms: input.printForms,
      settings: input.settings,
    })
    await grantAccess(
      tx,
      ctx,
      object.id,
      [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
      { quiet: true },
    )
    await publishEvent(tx, ctx, {
      type: 'document_type.created',
      object: { id: object.id, type: 'document_type', spaceId, title: input.name.ru },
      payload: { key: input.key, direction: input.direction },
    })
    return object.id
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: DocumentTypeUpdateInput): Promise<void> {
    await authorize(ctx, 'manage', id)
    const current = await DocumentTypeService.load(tx, id)
    if (!current) throw errors.notFound('Тип документа')

    const allowed = patch.confidentialityAllowed ?? current.confidentialityAllowed
    const fallback = patch.defaultConfidentiality ?? current.defaultConfidentiality
    assertConfidentiality(allowed, fallback)
    if (patch.cardSchema) assertCardSchema(patch.cardSchema)
    if (patch.numbering) await assertJournal(tx, patch.numbering.journalId)

    const values: Record<string, unknown> = {}
    const changed: string[] = []
    const set = (key: string, value: unknown) => {
      values[key] = value
      changed.push(key)
    }
    if (patch.name) set('name', patch.name)
    if (patch.cardSchema) set('cardSchema', patch.cardSchema)
    if (patch.numbering) set('numbering', patch.numbering)
    if (patch.defaultRouteKey !== undefined) set('defaultRouteKey', patch.defaultRouteKey)
    if (patch.retentionYears !== undefined) set('retentionYears', patch.retentionYears)
    if (patch.confidentialityAllowed) set('confidentialityAllowed', patch.confidentialityAllowed)
    if (patch.defaultConfidentiality) set('defaultConfidentiality', patch.defaultConfidentiality)
    if (patch.printForms) set('printForms', patch.printForms)
    if (patch.settings) set('settings', { ...current.settings, ...patch.settings })
    if (patch.isActive !== undefined) set('isActive', patch.isActive)
    if (changed.length === 0) return

    await tx.update(documentTypes).set(values).where(eq(documentTypes.id, id))
    // Название — событие реестра (лента, поиск); остальное — событие типа
    const object = patch.name
      ? await ObjectService.update(tx, ctx, id, { title: patch.name.ru })
      : await ObjectService.get(id, tx)
    await publishEvent(tx, ctx, {
      type: 'document_type.updated',
      object: {
        id,
        type: 'document_type',
        spaceId: object?.spaceId ?? null,
        title: object?.title ?? current.name.ru,
      },
      payload: { key: current.key, changed },
    })
  },
}
