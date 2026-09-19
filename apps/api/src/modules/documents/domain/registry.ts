import {
  CASE_STATUSES,
  CONFIDENTIALITY_LEVELS,
  DOCUMENT_CONTROLS,
  DOCUMENT_DIRECTIONS,
  DOCUMENT_STATUSES,
  type ObjectSummary,
} from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import type { ListFieldDef, SearchContent } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import {
  cases,
  documentDispatches,
  documents,
  documentTypes,
  journals,
  links,
  objects,
} from '~/shared/db/schema/index.js'
import { CorrespondentService } from './correspondent-service.js'
import { isOverdue } from './document-service.js'
import { todayLocal } from './journal-service.js'

const meta = (key: string) => sql`${objects.meta}->>${key}`

/**
 * Поля списка документов (CollectionView «Документы», сохранённые
 * представления): сводные поля реестра, которые модуль держит в `objects.meta`,
 * и гриф — столбец ядра.
 */
export const DOCUMENT_LIST_FIELDS: ListFieldDef[] = [
  {
    key: 'status',
    labelKey: 'documents.fields.status',
    type: 'select',
    sql: meta('status'),
    sortable: true,
    options: DOCUMENT_STATUSES.map((value) => ({
      value,
      labelKey: `documents.statuses.${value}`,
    })),
  },
  {
    key: 'direction',
    labelKey: 'documents.fields.direction',
    type: 'select',
    sql: meta('direction'),
    options: DOCUMENT_DIRECTIONS.map((value) => ({
      value,
      labelKey: `documents.directions.${value}`,
    })),
  },
  { key: 'typeId', labelKey: 'documents.fields.type', type: 'object_ref', sql: meta('typeId') },
  {
    key: 'regNumber',
    labelKey: 'documents.fields.regNumber',
    type: 'text',
    sql: meta('regNumber'),
    sortable: true,
  },
  {
    key: 'regDate',
    labelKey: 'documents.fields.regDate',
    type: 'date',
    sql: sql`(${objects.meta}->>'regDate')::date`,
    sortable: true,
  },
  {
    key: 'journalId',
    labelKey: 'documents.fields.journal',
    type: 'object_ref',
    sql: meta('journalId'),
  },
  {
    key: 'correspondentId',
    labelKey: 'documents.fields.correspondent',
    type: 'object_ref',
    sql: meta('correspondentId'),
  },
  { key: 'authorId', labelKey: 'documents.fields.author', type: 'user', sql: meta('authorId') },
  {
    key: 'responsibleId',
    labelKey: 'documents.fields.responsible',
    type: 'user',
    sql: meta('responsibleId'),
  },
  { key: 'signerId', labelKey: 'documents.fields.signer', type: 'user', sql: meta('signerId') },
  {
    key: 'controllerId',
    labelKey: 'documents.fields.controller',
    type: 'user',
    sql: meta('controllerId'),
  },
  {
    key: 'deadline',
    labelKey: 'documents.fields.deadline',
    type: 'date',
    sql: sql`(${objects.meta}->>'deadline')::date`,
    sortable: true,
  },
  {
    key: 'control',
    labelKey: 'documents.fields.control',
    type: 'select',
    sql: meta('control'),
    options: DOCUMENT_CONTROLS.map((value) => ({
      value,
      labelKey: `documents.controls.${value}`,
    })),
  },
  {
    key: 'confidentiality',
    labelKey: 'documents.fields.confidentiality',
    type: 'select',
    sql: sql`${objects.confidentiality}`,
    options: CONFIDENTIALITY_LEVELS.map((value) => ({
      value,
      labelKey: `access.confidentiality.${value}`,
    })),
  },
  { key: 'unitId', labelKey: 'documents.fields.unit', type: 'unit', sql: meta('unitId') },
  {
    key: 'closed',
    labelKey: 'documents.fields.closed',
    type: 'boolean',
    sql: sql`(${objects.meta}->>'closed')::boolean`,
  },
  // Дела и переписка (ADR-0086). Подзапросы ссылаются на внешнюю строку
  // буквально: поля используются только в условиях, не в списке select
  { key: 'caseId', labelKey: 'documents.fields.case', type: 'object_ref', sql: meta('caseId') },
  {
    key: 'dispatched',
    labelKey: 'documents.fields.dispatched',
    type: 'boolean',
    sql: sql`EXISTS (SELECT 1 FROM ${documentDispatches} dd WHERE dd.document_id = "objects"."id")`,
  },
  {
    key: 'answered',
    labelKey: 'documents.fields.answered',
    type: 'boolean',
    sql: sql`EXISTS (SELECT 1 FROM ${links} l JOIN ${documentDispatches} dd ON dd.document_id = l.source_id
      WHERE l.target_id = "objects"."id" AND l.kind = 'reply_to')`,
  },
  {
    key: 'replyTo',
    labelKey: 'documents.fields.replyTo',
    type: 'object_ref',
    sql: sql`(SELECT l.target_id::text FROM ${links} l
      WHERE l.source_id = "objects"."id" AND l.kind = 'reply_to' LIMIT 1)`,
  },
]

/** Поля списка дел номенклатуры (ADR-0086): сводные поля реестра. */
export const CASE_LIST_FIELDS: ListFieldDef[] = [
  {
    key: 'status',
    labelKey: 'documents.cases.fields.status',
    type: 'select',
    sql: meta('status'),
    options: CASE_STATUSES.map((value) => ({
      value,
      labelKey: `documents.cases.statuses.${value}`,
    })),
  },
  {
    key: 'year',
    labelKey: 'documents.cases.fields.year',
    type: 'integer',
    sql: sql`(${objects.meta}->>'year')::int`,
    sortable: true,
  },
  {
    key: 'index',
    labelKey: 'documents.cases.fields.index',
    type: 'text',
    sql: meta('index'),
    sortable: true,
  },
  { key: 'unitId', labelKey: 'documents.fields.unit', type: 'unit', sql: meta('unitId') },
]

/**
 * Сводка документа для списков, чипов и пикеров: реквизиты из таблицы модуля
 * и имена (тип, журнал, корреспондент, ответственный) — всегда актуальные.
 */
export async function documentSummaries(
  ids: string[],
): Promise<Map<string, Partial<ObjectSummary>>> {
  const rows = await db()
    .select({
      id: documents.id,
      typeId: documents.typeId,
      typeKey: documentTypes.key,
      typeName: documentTypes.name,
      direction: documentTypes.direction,
      status: documents.status,
      regNumber: documents.regNumber,
      regDate: documents.regDate,
      journalId: documents.journalId,
      journalName: journals.name,
      correspondentId: documents.correspondentId,
      responsibleId: documents.responsibleId,
      authorId: documents.authorId,
      controllerId: documents.controllerId,
      signerId: documents.signerId,
      deadline: documents.deadline,
      control: documents.control,
      unitId: documents.unitId,
      caseId: documents.caseId,
      caseIndex: cases.index,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
    .leftJoin(journals, eq(journals.id, documents.journalId))
    .leftJoin(cases, eq(cases.id, documents.caseId))
    .where(inArray(documents.id, ids))
  const [correspondents, people] = await Promise.all([
    CorrespondentService.names(db(), [
      ...new Set(rows.map((row) => row.correspondentId).filter((v): v is string => !!v)),
    ]),
    directory().refs([
      ...new Set(rows.map((row) => row.responsibleId).filter((v): v is string => !!v)),
    ]),
  ])
  const today = todayLocal()
  return new Map(
    rows.map((row) => [
      row.id,
      {
        meta: {
          ...row,
          typeName: row.typeName,
          correspondentName: row.correspondentId
            ? (correspondents.get(row.correspondentId)?.name ?? null)
            : null,
          responsible: row.responsibleId ? (people.get(row.responsibleId) ?? null) : null,
          overdue: isOverdue(row, today),
        },
      } as Partial<ObjectSummary>,
    ]),
  )
}

/** Документ в поиске: тема, номер, реквизиты отправителя, суть и поля карточки. */
export async function documentSearchContent(id: string): Promise<SearchContent | null> {
  const [row] = await db()
    .select({
      title: objects.title,
      spaceId: objects.spaceId,
      parentId: objects.parentId,
      ownerId: objects.ownerId,
      updatedAt: objects.updatedAt,
      regNumber: documents.regNumber,
      externalNumber: documents.externalNumber,
      summary: documents.summary,
      fields: documents.fields,
      status: documents.status,
      typeKey: documentTypes.key,
      correspondentId: documents.correspondentId,
    })
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
    .where(eq(documents.id, id))
    .limit(1)
  if (!row) return null
  const correspondent = row.correspondentId
    ? (await CorrespondentService.names(db(), [row.correspondentId])).get(row.correspondentId)
    : undefined
  const fieldText = Object.values(row.fields)
    .filter((value): value is string | number => ['string', 'number'].includes(typeof value))
    .join('\n')
  return {
    parentId: row.parentId,
    type: 'document',
    spaceId: row.spaceId,
    title: row.title,
    body: [row.regNumber, row.externalNumber, correspondent?.name, row.summary, fieldText]
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000),
    ownerId: row.ownerId,
    updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
    meta: { status: row.status, regNumber: row.regNumber, typeKey: row.typeKey },
  }
}
