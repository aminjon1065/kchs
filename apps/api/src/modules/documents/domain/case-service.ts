import {
  type CaseCreateInput,
  type CaseListQuery,
  type CaseMatch,
  type CaseRecord,
  type CaseRef,
  type CaseStatus,
  type CaseSuggestions,
  type CaseUpdateInput,
  canTransition,
  caseDestroyableFrom,
  type DestructionActInput,
  type DestructionActRecord,
  type DocumentStatus,
} from '@kchs/contracts'
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { destroyFiles } from '~/modules/files/public.js'
import { OrgService } from '~/modules/identity/public.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  caseDestructionActs,
  cases,
  documents,
  documentTypes,
  documentVersions,
  objects,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { todayLocal } from './journal-service.js'
import { applyTransition } from './lifecycle.js'
import { documentsSpaceId } from './space.js'

const COLUMNS = {
  id: cases.id,
  index: cases.index,
  title: cases.title,
  year: cases.year,
  unitId: cases.unitId,
  retentionYears: cases.retentionYears,
  retentionNote: cases.retentionNote,
  documentTypeIds: cases.documentTypeIds,
  status: cases.status,
  note: cases.note,
  closedAt: cases.closedAt,
  closedBy: cases.closedBy,
  archivedAt: cases.archivedAt,
  archivedBy: cases.archivedBy,
  destroyedAt: cases.destroyedAt,
  destructionActId: cases.destructionActId,
  spaceId: objects.spaceId,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function selectCases(executor: Executor) {
  return executor.select(COLUMNS).from(cases).innerJoin(objects, eq(objects.id, cases.id))
}

export type CaseRow = Awaited<ReturnType<typeof selectCases>>[number]

async function loadCase(executor: Executor, id: string, lock = false): Promise<CaseRow | null> {
  const query = selectCases(executor)
    .where(and(eq(cases.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: cases }) : await query
  return row ?? null
}

/** Подзаголовок в реестре: индекс и год — чипы, поиск, вкладки. */
const subtitleOf = (row: { index: string; year: number }) => `${row.index} · ${row.year}`

/** Сводка дела в реестре: фильтры списков и чипов без чтения таблицы модуля. */
const metaOf = (row: { index: string; year: number; status: string; unitId: string | null }) => ({
  index: row.index,
  year: row.year,
  status: row.status,
  unitId: row.unitId,
})

const refOf = (row: CaseRow): CaseRef => ({
  id: row.id,
  index: row.index,
  title: row.title,
  year: row.year,
  status: row.status as CaseStatus,
})

async function emit(
  tx: Executor,
  ctx: Ctx,
  row: { id: string; spaceId: string | null; title: string },
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await publishEvent(tx, ctx, {
    type,
    object: { id: row.id, type: 'case', spaceId: row.spaceId, title: row.title },
    payload,
  })
}

async function assertUnit(unitId: string | null | undefined): Promise<void> {
  if (!unitId) return
  if (!(await OrgService.briefs([unitId])).has(unitId)) {
    throw errors.validation('Подразделение не найдено', [{ path: 'unitId', message: 'unit' }])
  }
}

async function assertTypes(executor: Executor, typeIds: string[] | undefined): Promise<void> {
  if (!typeIds?.length) return
  const found = await executor
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .where(inArray(documentTypes.id, typeIds))
  if (found.length !== new Set(typeIds).size) {
    throw errors.validation('Тип документа не найден', [
      { path: 'documentTypeIds', message: 'type' },
    ])
  }
}

/** Индекс свободен в году: уникальность без учёта регистра держит и индекс базы. */
async function assertIndexFree(
  executor: Executor,
  index: string,
  year: number,
  exceptId: string | null,
): Promise<void> {
  const [taken] = await executor
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.year, year),
        sql`lower(${cases.index}) = lower(${index})`,
        ...(exceptId ? [sql`${cases.id} <> ${exceptId}`] : []),
      ),
    )
    .limit(1)
  if (taken) {
    throw errors.conflict('Дело с таким индексом в этом году уже есть', { index, year })
  }
}

async function documentCount(executor: Executor, caseId: string): Promise<number> {
  const [row] = await executor
    .select({ total: count() })
    .from(documents)
    .where(eq(documents.caseId, caseId))
  return row?.total ?? 0
}

/**
 * Документ подшивается в дело исполненным или зарегистрированным без контроля
 * («не требует исполнения»): документ на контроле ждёт исполнения.
 */
export function canFile(status: DocumentStatus, control: string): boolean {
  return status === 'executed' || (status === 'registered' && control !== 'on')
}

/** Файлы документа: вложения (сканы, версии, приложения) и файлы версий. */
async function documentFiles(executor: Executor, documentId: string): Promise<string[]> {
  const [attached, versions] = await Promise.all([
    // Вложения прикреплены до акта — читаются вне транзакции
    LinkService.attachments(documentId),
    executor
      .select({
        main: documentVersions.mainFileId,
        pdf: documentVersions.pdfFileId,
        attachments: documentVersions.attachments,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId)),
  ])
  const ids = new Set<string>(attached)
  for (const version of versions) {
    if (version.main) ids.add(version.main)
    if (version.pdf) ids.add(version.pdf)
    for (const id of version.attachments) ids.add(id)
  }
  return [...ids]
}

/**
 * Открытые дела, подходящие документу: видимые и с правом подшивать; по типу и подразделению
 * (сначала оба совпадения), свежий год выше. Предлагается единственное лучшее совпадение.
 */
async function rankCases(
  executor: Executor,
  ctx: Ctx,
  input: { typeId: string; unitId: string | null; year: number | null },
): Promise<CaseSuggestions> {
  const rows = await selectCases(executor)
    .where(
      and(
        eq(cases.status, 'open'),
        sql`${objects.deletedAt} IS NULL`,
        visibleObjectsSql(ctx, 'case'),
        ...(input.year !== null ? [eq(cases.year, input.year)] : []),
      ),
    )
    .orderBy(desc(cases.year), asc(cases.index))
    .limit(500)
  const units = await OrgService.briefs([
    ...new Set(rows.map((row) => row.unitId).filter((v): v is string => !!v)),
  ])
  const rank: Record<CaseMatch, number> = { type_unit: 0, type: 1, unit: 2, other: 3 }
  const items = []
  for (const row of rows) {
    const decision = await authorize(ctx, 'file_in', row.id, { soft: true })
    if (!decision.allowed) continue
    const byType = row.documentTypeIds.includes(input.typeId)
    const byUnit = input.unitId !== null && row.unitId === input.unitId
    const match: CaseMatch =
      byType && byUnit ? 'type_unit' : byType ? 'type' : byUnit ? 'unit' : 'other'
    const unit = row.unitId ? units.get(row.unitId) : undefined
    items.push({ ...refOf(row), unitName: unit?.name.ru ?? null, match })
  }
  items.sort((a, b) => rank[a.match] - rank[b.match] || b.year - a.year)
  const best = items[0]
  const second = items[1]
  const suggestedId =
    best &&
    best.match !== 'other' &&
    (!second || rank[second.match] > rank[best.match] || second.year < best.year)
      ? best.id
      : null
  return { items, suggestedId }
}

/**
 * Номенклатура дел (08-documents.md §12, ADR-0086). Дело — объект реестра без
 * владельца в пространстве документооборота: ведут его владельцы способности
 * «вести журналы» (производный `manage`), подшивают документы делопроизводители
 * (запись ACL `role:registrar → edit`, как у журналов). Документ, подшитый в
 * дело, остаётся под своим журналом — права на него дело не меняет.
 */
export const CaseService = {
  load: loadCase,

  async list(ctx: UserCtx, query: CaseListQuery): Promise<CaseRecord[]> {
    const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null
    const rows = await selectCases(db())
      .where(
        and(
          visibleObjectsSql(ctx, 'case'),
          sql`${objects.deletedAt} IS NULL`,
          ...(query.year !== undefined ? [eq(cases.year, query.year)] : []),
          ...(query.status ? [eq(cases.status, query.status)] : []),
          ...(query.unitId ? [eq(cases.unitId, query.unitId)] : []),
          ...(pattern ? [or(ilike(cases.index, pattern), ilike(cases.title, pattern))] : []),
        ),
      )
      .orderBy(desc(cases.year), asc(cases.index))
      .limit(1000)
    return CaseService.records(ctx, rows)
  },

  async get(ctx: UserCtx, id: string): Promise<CaseRecord> {
    await authorize(ctx, 'view', id)
    const row = await loadCase(db(), id)
    if (!row) throw errors.notFound('Дело')
    const [record] = await CaseService.records(ctx, [row])
    if (!record) throw errors.notFound('Дело')
    return record
  },

  async records(ctx: UserCtx, rows: CaseRow[]): Promise<CaseRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const actIds = rows.map((row) => row.destructionActId).filter((v): v is string => !!v)
    const [counts, units, people, acts] = await Promise.all([
      // Число документов — только видимых смотрящему: скрытые грифом не считаются
      db()
        .select({ caseId: documents.caseId, total: count() })
        .from(documents)
        .innerJoin(objects, eq(objects.id, documents.id))
        .where(
          and(
            inArray(documents.caseId, ids),
            sql`${objects.deletedAt} IS NULL`,
            visibleObjectsSql(ctx, 'document'),
          ),
        )
        .groupBy(documents.caseId),
      OrgService.briefs([
        ...new Set(rows.map((row) => row.unitId).filter((v): v is string => !!v)),
      ]),
      directory().refs([
        ...new Set(
          rows.flatMap((row) => [row.closedBy, row.archivedBy]).filter((v): v is string => !!v),
        ),
      ]),
      actIds.length
        ? db()
            .select({
              id: caseDestructionActs.id,
              number: caseDestructionActs.number,
              actDate: caseDestructionActs.actDate,
            })
            .from(caseDestructionActs)
            .where(inArray(caseDestructionActs.id, actIds))
        : Promise.resolve([]),
    ])
    const result: CaseRecord[] = []
    for (const row of rows) {
      const [manage, fileIn] = await Promise.all([
        authorize(ctx, 'manage', row.id, { soft: true }),
        authorize(ctx, 'file_in', row.id, { soft: true }),
      ])
      const unit = row.unitId ? units.get(row.unitId) : undefined
      const act = acts.find((item) => item.id === row.destructionActId)
      result.push({
        id: row.id,
        index: row.index,
        title: row.title,
        year: row.year,
        unit: unit ? { id: unit.id, name: unit.name.ru } : null,
        retentionYears: row.retentionYears,
        retentionNote: row.retentionNote,
        documentTypeIds: row.documentTypeIds,
        status: row.status as CaseStatus,
        note: row.note,
        documentCount: counts.find((item) => item.caseId === row.id)?.total ?? 0,
        destroyableFrom: caseDestroyableFrom(row.year, row.retentionYears),
        closedAt: row.closedAt,
        closedBy: row.closedBy ? (people.get(row.closedBy) ?? null) : null,
        archivedAt: row.archivedAt,
        archivedBy: row.archivedBy ? (people.get(row.archivedBy) ?? null) : null,
        destroyedAt: row.destroyedAt,
        destructionAct: act ? { id: act.id, number: act.number, actDate: act.actDate } : null,
        canManage: manage.allowed && row.status !== 'destroyed',
        canFile: fileIn.allowed && row.status === 'open',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    return result
  },

  /** Ссылки на дела для карточек документов — без проверки прав на дело. */
  async refs(executor: Executor, ids: string[]): Promise<Map<string, CaseRef>> {
    if (ids.length === 0) return new Map()
    const rows = await selectCases(executor).where(inArray(cases.id, ids))
    return new Map(rows.map((row) => [row.id, refOf(row)]))
  },

  async create(tx: Executor, ctx: Ctx, input: CaseCreateInput): Promise<string> {
    requireCapability(ctx, 'documents.journals.manage')
    await assertUnit(input.unitId)
    await assertTypes(tx, input.documentTypeIds)
    await assertIndexFree(tx, input.index, input.year, null)
    const spaceId = await documentsSpaceId(tx)
    const row = { ...input, status: 'open' as const }
    // Без владельца, как журнал: дело ведёт канцелярия, а не автор записи
    const object = await ObjectService.create(tx, ctx, {
      type: 'case',
      spaceId,
      title: input.title,
      subtitle: subtitleOf(input),
      ownerId: null,
      meta: metaOf(row),
    })
    await tx.insert(cases).values({
      id: object.id,
      index: input.index,
      title: input.title,
      year: input.year,
      unitId: input.unitId,
      retentionYears: input.retentionYears,
      retentionNote: input.retentionNote,
      documentTypeIds: input.documentTypeIds,
      note: input.note,
    })
    // Подшивают делопроизводители; сузить до канцелярии подразделения — «Поделиться»
    await grantAccess(
      tx,
      ctx,
      object.id,
      [
        {
          principal: { type: 'role', id: 'registrar' },
          level: 'edit',
          note: 'делопроизводители дела',
        },
      ],
      { quiet: true },
    )
    await emit(tx, ctx, { id: object.id, spaceId, title: input.title }, 'case.created', {
      index: input.index,
      year: input.year,
    })
    return object.id
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: CaseUpdateInput): Promise<void> {
    await authorize(ctx, 'manage', id)
    const row = await loadCase(tx, id, true)
    if (!row) throw errors.notFound('Дело')
    if (row.status === 'destroyed') throw errors.conflict('Дело уничтожено — оно не меняется')
    const next = {
      index: patch.index ?? row.index,
      title: patch.title ?? row.title,
      year: patch.year ?? row.year,
      unitId: patch.unitId === undefined ? row.unitId : patch.unitId,
      retentionYears:
        patch.retentionYears === undefined ? row.retentionYears : patch.retentionYears,
      retentionNote: patch.retentionNote === undefined ? row.retentionNote : patch.retentionNote,
      documentTypeIds: patch.documentTypeIds ?? row.documentTypeIds,
      note: patch.note === undefined ? row.note : patch.note,
    }
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(row[key]),
    )
    if (changed.length === 0) return
    if (
      (changed.includes('index') || changed.includes('year')) &&
      (await documentCount(tx, id)) > 0
    ) {
      throw errors.conflict('В деле есть документы — индекс и год не меняются')
    }
    await assertUnit(patch.unitId)
    await assertTypes(tx, patch.documentTypeIds)
    if (changed.includes('index') || changed.includes('year')) {
      await assertIndexFree(tx, next.index, next.year, id)
    }
    await tx.update(cases).set(next).where(eq(cases.id, id))
    await ObjectService.update(
      tx,
      ctx,
      id,
      {
        title: next.title,
        subtitle: subtitleOf(next),
        meta: metaOf({ ...next, status: row.status }),
        mergeMeta: true,
      },
      { silent: !changed.includes('title') },
    )
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: next.title }, 'case.updated', {
      changed,
    })
  },

  /** Закрыть дело: подшивать в него больше нельзя (конец года, дело завершено). */
  async close(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    await authorize(ctx, 'manage', id)
    const row = await loadCase(tx, id, true)
    if (!row) throw errors.notFound('Дело')
    if (row.status !== 'open') throw errors.conflict('Закрыть можно только открытое дело')
    await tx
      .update(cases)
      .set({ status: 'closed', closedAt: sql`now()`, closedBy: actorId(ctx) })
      .where(eq(cases.id, id))
    await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: metaOf({ ...row, status: 'closed' }), mergeMeta: true },
      { silent: true },
    )
    const documentsInCase = await documentCount(tx, id)
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: row.title }, 'case.closed', {
      index: row.index,
      year: row.year,
      documents: documentsInCase,
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.caseClosed,
        objectId: id,
        objectType: 'case',
        details: { index: row.index, year: row.year, documents: documentsInCase },
      },
      tx,
    )
  },

  /** Вернуть закрытое дело в работу — пока оно не передано в архив. */
  async reopen(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    await authorize(ctx, 'manage', id)
    const row = await loadCase(tx, id, true)
    if (!row) throw errors.notFound('Дело')
    if (row.status !== 'closed') throw errors.conflict('Открыть можно только закрытое дело')
    await tx
      .update(cases)
      .set({ status: 'open', closedAt: null, closedBy: null })
      .where(eq(cases.id, id))
    await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: metaOf({ ...row, status: 'open' }), mergeMeta: true },
      { silent: true },
    )
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: row.title }, 'case.reopened', {
      index: row.index,
      year: row.year,
    })
  },

  /** Закрыть открытые дела года, которые ведёт пользователь (конец делопроизводственного года). */
  async closeYear(tx: Executor, ctx: Ctx, year: number): Promise<number> {
    requireCapability(ctx, 'documents.journals.manage')
    const open = await tx
      .select({ id: cases.id })
      .from(cases)
      .innerJoin(objects, eq(objects.id, cases.id))
      .where(
        and(
          eq(cases.year, year),
          eq(cases.status, 'open'),
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'case'),
        ),
      )
      .orderBy(asc(cases.index))
    let closed = 0
    for (const item of open) {
      const decision = await authorize(ctx, 'manage', item.id, { soft: true })
      if (!decision.allowed) continue
      await CaseService.close(tx, ctx, item.id)
      closed += 1
    }
    return closed
  },

  /**
   * Передать закрытое дело в архив: документы дела — «В архиве» (переход
   * жизненного цикла с причиной `archive`), дело — «В архиве».
   */
  async archive(tx: Executor, ctx: Ctx, id: string): Promise<number> {
    await authorize(ctx, 'manage', id)
    const row = await loadCase(tx, id, true)
    if (!row) throw errors.notFound('Дело')
    if (row.status !== 'closed') throw errors.conflict('Передать в архив можно закрытое дело')
    const filed = await tx
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.caseId, id))
      .orderBy(asc(documents.filedAt))
    let archived = 0
    for (const doc of filed) {
      if (!canTransition(doc.status as DocumentStatus, 'archived')) continue
      await applyTransition(tx, ctx, doc.id, {
        to: 'archived',
        cause: 'archive',
        source: { kind: 'case', id },
      })
      archived += 1
    }
    await tx
      .update(cases)
      .set({ status: 'archived', archivedAt: sql`now()`, archivedBy: actorId(ctx) })
      .where(eq(cases.id, id))
    await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: metaOf({ ...row, status: 'archived' }), mergeMeta: true },
      { silent: true },
    )
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: row.title }, 'case.archived', {
      index: row.index,
      year: row.year,
      documents: archived,
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.caseArchived,
        objectId: id,
        objectType: 'case',
        details: { index: row.index, year: row.year, documents: archived },
      },
      tx,
    )
    return archived
  },

  /**
   * Открытые дела для документа: видимые пользователю, в которые он вправе подшивать; сначала
   * совпавшие по типу и подразделению документа. Для подшивки — дела любого года (текущего
   * выше) и первым дело, указанное при регистрации; для регистрации — дела года регистрации:
   * индекс идёт в номер (ADR-0134).
   */
  async suggest(
    ctx: UserCtx,
    documentId: string,
    purpose: 'filing' | 'registration' = 'filing',
  ): Promise<CaseSuggestions> {
    await authorize(ctx, 'view', documentId)
    const [doc] = await db()
      .select({
        typeId: documents.typeId,
        unitId: documents.unitId,
        regCaseId: documents.regCaseId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    if (!doc) throw errors.notFound('Документ')
    const year = purpose === 'registration' ? Number(todayLocal().slice(0, 4)) : null
    const ranked = await rankCases(db(), ctx, { typeId: doc.typeId, unitId: doc.unitId, year })
    if (purpose === 'filing' && doc.regCaseId) {
      const at = ranked.items.findIndex((item) => item.id === doc.regCaseId)
      if (at >= 0) {
        const [chosen] = ranked.items.splice(at, 1)
        if (chosen) ranked.items.unshift(chosen)
        return { items: ranked.items, suggestedId: doc.regCaseId }
      }
    }
    return ranked
  },

  /**
   * Дело для номера при регистрации (ADR-0134): выбранное — открытое, года регистрации и с
   * правом подшивать в него; не выбранное — единственное лучшее по типу и подразделению;
   * `null` — без дела (тогда `{case.index}` берёт префикс журнала).
   */
  async forRegistration(
    executor: Executor,
    ctx: Ctx,
    input: { typeId: string; unitId: string | null; date: string; caseId?: string | null },
  ): Promise<{ id: string; index: string } | null> {
    if (input.caseId === null) return null
    const year = Number(input.date.slice(0, 4))
    if (input.caseId === undefined) {
      const ranked = await rankCases(executor, ctx, {
        typeId: input.typeId,
        unitId: input.unitId,
        year,
      })
      const best = ranked.items.find((item) => item.id === ranked.suggestedId)
      return best ? { id: best.id, index: best.index } : null
    }
    await authorize(ctx, 'file_in', input.caseId)
    const row = await loadCase(executor, input.caseId)
    if (!row) throw errors.notFound('Дело')
    if (row.status !== 'open') {
      throw errors.validation('Дело закрыто — выберите открытое дело номенклатуры', [
        { path: 'caseId', message: 'closed' },
      ])
    }
    if (row.year !== year) {
      throw errors.validation(`Дело ${row.index} — номенклатуры ${row.year} года`, [
        { path: 'caseId', message: 'year' },
      ])
    }
    return { id: row.id, index: row.index }
  },

  /**
   * Подшить документ в открытое дело (08-documents.md §3, §12): исполненный —
   * `executed → filed`; зарегистрированный без контроля «не требует
   * исполнения» — `registered → executed → filed` в одной транзакции. Дело
   * блокируется, чтобы закрытие и передача в архив не разошлись с подшивкой.
   */
  async fileDocument(tx: Executor, ctx: Ctx, documentId: string, caseId: string): Promise<void> {
    await authorize(ctx, 'file', documentId)
    await authorize(ctx, 'file_in', caseId)
    const target = await loadCase(tx, caseId, true)
    if (!target) throw errors.notFound('Дело')
    if (target.status !== 'open') throw errors.conflict('Дело закрыто — подшивать в него нельзя')
    const [doc] = await tx
      .select({
        status: documents.status,
        control: documents.control,
        title: objects.title,
        spaceId: objects.spaceId,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(eq(documents.id, documentId))
      .limit(1)
      .for('update', { of: documents })
    if (!doc) throw errors.notFound('Документ')
    if (!canFile(doc.status as DocumentStatus, doc.control)) {
      throw errors.conflict(
        'Подшить в дело можно исполненный документ или зарегистрированный без контроля',
        { status: doc.status, control: doc.control },
      )
    }
    await tx
      .update(documents)
      .set({ caseId, filedAt: sql`now()`, filedBy: actorId(ctx) })
      .where(eq(documents.id, documentId))
    const source = { kind: 'case', id: caseId }
    if (doc.status === 'registered') {
      await applyTransition(tx, ctx, documentId, { to: 'executed', cause: 'filing', source })
    }
    await applyTransition(tx, ctx, documentId, { to: 'filed', cause: 'filing', source })
    await ObjectService.update(
      tx,
      ctx,
      documentId,
      { meta: { caseId, caseIndex: target.index }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'document.filed',
      object: { id: documentId, type: 'document', spaceId: doc.spaceId, title: doc.title },
      payload: { caseId, index: target.index, caseTitle: target.title, year: target.year },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.documentFiled,
        objectId: documentId,
        objectType: 'document',
        details: { caseId, index: target.index, year: target.year },
      },
      tx,
    )
  },

  /**
   * Акт о выделении к уничтожению (08-documents.md §12): дела в архиве с
   * истёкшим сроком хранения. Файлы документов уничтожаются вместе с
   * содержимым, карточки документов остаются описью; дела — «Уничтожено».
   * Номер акта — порядковый в году; каждое дело — в аудит.
   */
  async destroy(tx: Executor, ctx: Ctx, input: DestructionActInput): Promise<string> {
    requireCapability(ctx, 'documents.journals.manage')
    const ids = [...new Set(input.caseIds)]
    const today = todayLocal()
    const rows = await selectCases(tx)
      .where(and(inArray(cases.id, ids), sql`${objects.deletedAt} IS NULL`))
      .orderBy(asc(cases.year), asc(cases.index))
      .for('update', { of: cases })
    if (rows.length !== ids.length) throw errors.notFound('Дело')
    for (const row of rows) {
      await authorize(ctx, 'manage', row.id)
      if (row.status !== 'archived') {
        throw errors.conflict('Уничтожить можно только дело, переданное в архив', {
          index: row.index,
          year: row.year,
        })
      }
      const from = caseDestroyableFrom(row.year, row.retentionYears)
      if (!from || from > today) {
        throw errors.conflict('Срок хранения дела не истёк', {
          index: row.index,
          year: row.year,
          destroyableFrom: from,
        })
      }
    }

    // Номер акта — порядковый в году; параллельные акты идут по очереди
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('documents:destruction-acts'))`)
    const year = Number(today.slice(0, 4))
    const [last] = await tx
      .select({ sequence: sql<number>`coalesce(max(${caseDestructionActs.sequence}), 0)::int` })
      .from(caseDestructionActs)
      .where(eq(caseDestructionActs.year, year))
    const sequence = (last?.sequence ?? 0) + 1
    const number = `${sequence}/${year}`
    const actId = newId()

    const docs = await tx
      .select({ id: documents.id, title: objects.title, spaceId: objects.spaceId })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(inArray(documents.caseId, ids))
    let fileCount = 0
    for (const doc of docs) {
      const destroyed = await destroyFiles(tx, ctx, await documentFiles(tx, doc.id))
      fileCount += destroyed
      await tx
        .update(documentVersions)
        .set({ mainFileId: null, pdfFileId: null, attachments: [], pdfStatus: 'none' })
        .where(eq(documentVersions.documentId, doc.id))
      await tx
        .update(documents)
        .set({ filesDestroyedAt: sql`now()` })
        .where(eq(documents.id, doc.id))
      await publishEvent(tx, ctx, {
        type: 'document.files_destroyed',
        object: { id: doc.id, type: 'document', spaceId: doc.spaceId, title: doc.title },
        payload: { actId, number, files: destroyed },
      })
    }

    await tx.insert(caseDestructionActs).values({
      id: actId,
      number,
      year,
      sequence,
      actDate: today,
      basis: input.basis,
      caseIds: ids,
      documentCount: docs.length,
      fileCount,
      createdBy: actorId(ctx),
    })
    for (const row of rows) {
      await tx
        .update(cases)
        .set({ status: 'destroyed', destroyedAt: sql`now()`, destructionActId: actId })
        .where(eq(cases.id, row.id))
      await ObjectService.update(
        tx,
        ctx,
        row.id,
        { meta: metaOf({ ...row, status: 'destroyed' }), mergeMeta: true },
        { silent: true },
      )
      const inCase = await documentCount(tx, row.id)
      await emit(tx, ctx, row, 'case.destroyed', { actId, number, documents: inCase })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.caseDestroyed,
          objectId: row.id,
          objectType: 'case',
          severity: 'warning',
          details: {
            actId,
            number,
            basis: input.basis,
            index: row.index,
            year: row.year,
            documents: inCase,
          },
        },
        tx,
      )
    }
    return actId
  },

  /** Акты о выделении к уничтожению — для канцелярии (новые сверху). */
  async acts(ctx: UserCtx): Promise<DestructionActRecord[]> {
    requireCapability(ctx, 'documents.journals.manage')
    const rows = await db()
      .select()
      .from(caseDestructionActs)
      .orderBy(desc(caseDestructionActs.createdAt))
      .limit(200)
    const caseRefs = await CaseService.refs(db(), [...new Set(rows.flatMap((row) => row.caseIds))])
    const people = await directory().refs([
      ...new Set(rows.map((row) => row.createdBy).filter((v): v is string => !!v)),
    ])
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      actDate: row.actDate,
      basis: row.basis,
      cases: row.caseIds.map((id) => caseRefs.get(id)).filter((v): v is CaseRef => !!v),
      documentCount: row.documentCount,
      fileCount: row.fileCount,
      createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt,
    }))
  },

  /** Дело можно удалить в корзину, пока оно открыто и пусто. */
  async assertDeletable(executor: Executor, id: string): Promise<void> {
    const row = await loadCase(executor, id)
    if (!row) return
    if (row.status !== 'open' || (await documentCount(executor, id)) > 0) {
      throw errors.conflict('Удалить можно только открытое дело без документов')
    }
  },
}
