import {
  counterYear,
  formatRegNumber,
  JournalCreateInput,
  type JournalRecord,
  type JournalReservation,
  type JournalReserveInput,
  type JournalReset,
  type JournalUpdateInput,
} from '@kchs/contracts'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { localDate } from '~/kernel/business-calendar/working-days.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { OrgService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  documents,
  documentTypes,
  journalCounters,
  journalReservations,
  journals,
  objects,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { documentsSpaceId } from './space.js'

export interface JournalRow {
  id: string
  name: string
  prefix: string
  format: string
  reset: JournalReset
  unitId: string | null
  typeIds: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

const COLUMNS = {
  id: journals.id,
  name: journals.name,
  prefix: journals.prefix,
  format: journals.format,
  reset: journals.reset,
  unitId: journals.unitId,
  typeIds: journals.typeIds,
  isActive: journals.isActive,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function selectJournals(executor: Executor) {
  return executor.select(COLUMNS).from(journals).innerJoin(objects, eq(objects.id, journals.id))
}

function toRow(raw: Awaited<ReturnType<typeof selectJournals>>[number]): JournalRow {
  return { ...raw, reset: raw.reset === 'never' ? 'never' : 'year' }
}

/** Сегодняшняя дата организации (часовой пояс установки). */
export function todayLocal(): string {
  return localDate(new Date(), config().TZ)
}

/** Номер из счётчика или резерва, выданный в транзакции регистрации. */
export interface IssuedNumber {
  number: string
  sequence: number
  year: number
  reservationId: string | null
}

async function unitCode(unitId: string | null): Promise<string | null> {
  if (!unitId) return null
  return (await OrgService.briefs([unitId])).get(unitId)?.code ?? null
}

/**
 * Журналы регистрации и нумерация (08-documents.md §5, ADR-0080). Журнал —
 * объект реестра без владельца: делопроизводители журнала — записи его ACL
 * (по умолчанию `role:registrar → edit`), зарегистрированные документы —
 * дочерние объекты журнала и наследуют эти права. Ведут журналы владельцы
 * способности `documents.journals.manage` (производный `manage`).
 */
export const JournalService = {
  async load(executor: Executor, id: string): Promise<JournalRow | null> {
    const [raw] = await selectJournals(executor).where(eq(journals.id, id)).limit(1)
    return raw ? toRow(raw) : null
  },

  async list(ctx: UserCtx, options: { includeInactive?: boolean } = {}): Promise<JournalRecord[]> {
    const rows = await selectJournals(db())
      .where(
        and(
          visibleObjectsSql(ctx, 'journal'),
          sql`${objects.deletedAt} IS NULL`,
          ...(options.includeInactive ? [] : [eq(journals.isActive, true)]),
        ),
      )
      .orderBy(asc(journals.name))
    return JournalService.records(ctx, rows.map(toRow))
  },

  async get(ctx: UserCtx, id: string): Promise<JournalRecord> {
    await authorize(ctx, 'view', id)
    const row = await JournalService.load(db(), id)
    if (!row) throw errors.notFound('Журнал')
    const [record] = await JournalService.records(ctx, [row])
    if (!record) throw errors.notFound('Журнал')
    return record
  },

  async records(ctx: UserCtx, rows: JournalRow[]): Promise<JournalRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const today = todayLocal()
    const [counters, reserved, docs, units] = await Promise.all([
      db().select().from(journalCounters).where(inArray(journalCounters.journalId, ids)),
      db()
        .select({ journalId: journalReservations.journalId, total: count() })
        .from(journalReservations)
        .where(
          and(inArray(journalReservations.journalId, ids), eq(journalReservations.state, 'open')),
        )
        .groupBy(journalReservations.journalId),
      // Число документов — только видимых смотрящему: скрытые грифом не считаются
      db()
        .select({ journalId: documents.journalId, total: count() })
        .from(documents)
        .innerJoin(objects, eq(objects.id, documents.id))
        .where(
          and(
            inArray(documents.journalId, ids),
            sql`${objects.deletedAt} IS NULL`,
            visibleObjectsSql(ctx, 'document'),
          ),
        )
        .groupBy(documents.journalId),
      OrgService.briefs([
        ...new Set(rows.map((row) => row.unitId).filter((v): v is string => !!v)),
      ]),
    ])
    const result: JournalRecord[] = []
    for (const row of rows) {
      const year = counterYear(row.reset, today)
      const last =
        counters.find((counter) => counter.journalId === row.id && counter.year === year)
          ?.lastSeq ?? 0
      const unit = row.unitId ? units.get(row.unitId) : undefined
      const [manage, register] = await Promise.all([
        authorize(ctx, 'manage', row.id, { soft: true }),
        authorize(ctx, 'register_in', row.id, { soft: true }),
      ])
      result.push({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        format: row.format,
        reset: row.reset,
        unit: unit ? { id: unit.id, name: unit.name.ru, code: unit.code } : null,
        typeIds: row.typeIds,
        isActive: row.isActive,
        lastSequence: last,
        nextNumber: formatRegNumber(row.format, {
          prefix: row.prefix,
          sequence: last + 1,
          date: today,
          unitCode: unit?.code ?? null,
        }),
        openReservations: reserved.find((item) => item.journalId === row.id)?.total ?? 0,
        documentCount: docs.find((item) => item.journalId === row.id)?.total ?? 0,
        canManage: manage.allowed,
        canRegister: register.allowed,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    return result
  },

  async create(tx: Executor, ctx: Ctx, raw: JournalCreateInput): Promise<string> {
    requireCapability(ctx, 'documents.journals.manage')
    const input = JournalCreateInput.parse(raw)
    await assertTypes(tx, input.typeIds)
    const spaceId = await documentsSpaceId(tx)
    // Без владельца: права на журнал наследуют его документы, и владелец журнала
    // стал бы владельцем каждого зарегистрированного в нём документа
    const object = await ObjectService.create(tx, ctx, {
      type: 'journal',
      spaceId,
      title: input.name,
      subtitle: input.prefix || null,
      ownerId: null,
      meta: { format: input.format, reset: input.reset, unitId: input.unitId },
    })
    await tx.insert(journals).values({
      id: object.id,
      name: input.name,
      prefix: input.prefix,
      format: input.format,
      reset: input.reset,
      unitId: input.unitId,
      typeIds: input.typeIds,
    })
    // Делопроизводители по умолчанию — все с ролью registrar; сузить до
    // делопроизводителей подразделения — «Поделиться» журналом
    await grantAccess(
      tx,
      ctx,
      object.id,
      [
        {
          principal: { type: 'role', id: 'registrar' },
          level: 'edit',
          note: 'делопроизводители журнала',
        },
      ],
      { quiet: true },
    )
    await publishEvent(tx, ctx, {
      type: 'journal.created',
      object: { id: object.id, type: 'journal', spaceId, title: input.name },
      payload: { name: input.name, format: input.format },
    })
    return object.id
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: JournalUpdateInput): Promise<void> {
    await authorize(ctx, 'manage', id)
    const current = await JournalService.load(tx, id)
    if (!current) throw errors.notFound('Журнал')
    if (patch.typeIds) await assertTypes(tx, patch.typeIds)
    const values: Record<string, unknown> = {}
    for (const key of [
      'name',
      'prefix',
      'format',
      'reset',
      'unitId',
      'typeIds',
      'isActive',
    ] as const) {
      if (patch[key] !== undefined) values[key] = patch[key]
    }
    const changed = Object.keys(values)
    if (changed.length === 0) return
    await tx.update(journals).set(values).where(eq(journals.id, id))
    const object = await ObjectService.update(
      tx,
      ctx,
      id,
      {
        ...(patch.name ? { title: patch.name } : {}),
        ...(patch.prefix !== undefined ? { subtitle: patch.prefix || null } : {}),
        meta: {
          format: patch.format ?? current.format,
          reset: patch.reset ?? current.reset,
          unitId: patch.unitId === undefined ? current.unitId : patch.unitId,
        },
        mergeMeta: true,
      },
      { silent: !patch.name },
    )
    await publishEvent(tx, ctx, {
      type: 'journal.updated',
      object: { id, type: 'journal', spaceId: object.spaceId, title: object.title },
      payload: { changed },
    })
  },

  /**
   * Следующий номер журнала в транзакции регистрации: счётчик года (или
   * сквозной) увеличивается upsert-ом, строка счётчика заблокирована до конца
   * транзакции — параллельные регистрации идут по очереди, номера без пропусков
   * и повторов; уникальность в пределах года дополнительно держит индекс
   * `registrations(journal_id, year, sequence)`.
   */
  async issue(
    tx: Executor,
    journal: JournalRow,
    input: {
      date: string
      format?: string | null
      unitId?: string | null
      /** Индекс дела по номенклатуре для `{case.index}` (ADR-0134). */
      caseIndex?: string | null
      reservationId?: string
    },
  ): Promise<IssuedNumber> {
    if (input.reservationId) {
      const [reservation] = await tx
        .select()
        .from(journalReservations)
        .where(eq(journalReservations.id, input.reservationId))
        .limit(1)
        .for('update')
      if (!reservation || reservation.journalId !== journal.id) {
        throw errors.validation('Резерв номера не найден в этом журнале', [
          { path: 'reservationId', message: 'reservation' },
        ])
      }
      if (reservation.state !== 'open') {
        throw errors.conflict('Номер из резерва уже использован или снят')
      }
      return {
        number: reservation.number,
        sequence: reservation.sequence,
        year: reservation.year,
        reservationId: reservation.id,
      }
    }

    const year = counterYear(journal.reset, input.date)
    const [counter] = await tx
      .insert(journalCounters)
      .values({ journalId: journal.id, year, lastSeq: 1 })
      .onConflictDoUpdate({
        target: [journalCounters.journalId, journalCounters.year],
        set: { lastSeq: sql`${journalCounters.lastSeq} + 1` },
      })
      .returning({ lastSeq: journalCounters.lastSeq })
    if (!counter) throw errors.internal('Счётчик журнала не обновлён')
    const code = (await unitCode(input.unitId ?? null)) ?? (await unitCode(journal.unitId))
    return {
      number: formatRegNumber(input.format ?? journal.format, {
        prefix: journal.prefix,
        sequence: counter.lastSeq,
        date: input.date,
        unitCode: code,
        caseIndex: input.caseIndex ?? null,
      }),
      sequence: counter.lastSeq,
      year,
      reservationId: null,
    }
  },

  /**
   * Каким будет следующий номер — без выдачи и блокировки счётчика (предпросмотр в диалоге
   * регистрации, ADR-0134). Параллельная регистрация может занять его раньше.
   */
  async preview(
    executor: Executor,
    journal: JournalRow,
    input: {
      date: string
      format?: string | null
      unitId?: string | null
      caseIndex?: string | null
    },
  ): Promise<string> {
    const year = counterYear(journal.reset, input.date)
    const [counter] = await executor
      .select({ lastSeq: journalCounters.lastSeq })
      .from(journalCounters)
      .where(and(eq(journalCounters.journalId, journal.id), eq(journalCounters.year, year)))
      .limit(1)
    const code = (await unitCode(input.unitId ?? null)) ?? (await unitCode(journal.unitId))
    return formatRegNumber(input.format ?? journal.format, {
      prefix: journal.prefix,
      sequence: (counter?.lastSeq ?? 0) + 1,
      date: input.date,
      unitCode: code,
      caseIndex: input.caseIndex ?? null,
    })
  },

  /** Отметка: номер из резерва выдан документу (в транзакции регистрации). */
  async useReservation(tx: Executor, reservationId: string, documentId: string): Promise<void> {
    await tx
      .update(journalReservations)
      .set({ state: 'used', documentId, usedAt: sql`now()` })
      .where(eq(journalReservations.id, reservationId))
  },

  /**
   * Резервирование номеров для бумажных документов (08-documents.md §5):
   * N номеров из того же счётчика одной блокировкой, с примечанием.
   */
  async reserve(
    tx: Executor,
    ctx: Ctx,
    journalId: string,
    input: JournalReserveInput,
  ): Promise<JournalReservation[]> {
    await authorize(ctx, 'register_in', journalId)
    const journal = await JournalService.load(tx, journalId)
    if (!journal) throw errors.notFound('Журнал')
    if (!journal.isActive) throw errors.conflict('Журнал закрыт для регистрации')
    const date = input.date ?? todayLocal()
    const year = counterYear(journal.reset, date)
    const [counter] = await tx
      .insert(journalCounters)
      .values({ journalId, year, lastSeq: input.count })
      .onConflictDoUpdate({
        target: [journalCounters.journalId, journalCounters.year],
        set: { lastSeq: sql`${journalCounters.lastSeq} + ${input.count}` },
      })
      .returning({ lastSeq: journalCounters.lastSeq })
    if (!counter) throw errors.internal('Счётчик журнала не обновлён')
    const code = await unitCode(journal.unitId)
    const first = counter.lastSeq - input.count + 1
    const rows = Array.from({ length: input.count }, (_, index) => {
      const sequence = first + index
      return {
        id: newId(),
        journalId,
        year,
        sequence,
        number: formatRegNumber(journal.format, {
          prefix: journal.prefix,
          sequence,
          date,
          unitCode: code,
        }),
        note: input.note,
        reservedBy: actorId(ctx),
      }
    })
    await tx.insert(journalReservations).values(rows)
    await publishEvent(tx, ctx, {
      type: 'journal.numbers_reserved',
      object: { id: journalId, type: 'journal', title: journal.name },
      payload: {
        count: input.count,
        first: rows[0]?.number ?? '',
        last: rows[rows.length - 1]?.number ?? '',
        year,
      },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.journalNumbersReserved,
        objectId: journalId,
        objectType: 'journal',
        severity: 'notice',
        details: { count: input.count, first: rows[0]?.number, note: input.note },
      },
      tx,
    )
    return JournalService.reservationRecords(
      tx,
      rows.map((row) => row.id),
    )
  },

  async cancelReservation(
    tx: Executor,
    ctx: Ctx,
    journalId: string,
    reservationId: string,
  ): Promise<void> {
    await authorize(ctx, 'register_in', journalId)
    const [row] = await tx
      .update(journalReservations)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(journalReservations.id, reservationId),
          eq(journalReservations.journalId, journalId),
          eq(journalReservations.state, 'open'),
        ),
      )
      .returning({ id: journalReservations.id, number: journalReservations.number })
    if (!row) throw errors.conflict('Резерв уже использован, снят или не найден')
    await publishEvent(tx, ctx, {
      type: 'journal.reservation_cancelled',
      object: { id: journalId, type: 'journal' },
      payload: { reservationId, number: row.number },
    })
  },

  async reservations(
    ctx: UserCtx,
    journalId: string,
    state?: 'open' | 'used' | 'cancelled',
  ): Promise<JournalReservation[]> {
    await authorize(ctx, 'view', journalId)
    const rows = await db()
      .select({ id: journalReservations.id })
      .from(journalReservations)
      .where(
        and(
          eq(journalReservations.journalId, journalId),
          ...(state ? [eq(journalReservations.state, state)] : []),
        ),
      )
      .orderBy(asc(journalReservations.year), asc(journalReservations.sequence))
      .limit(500)
    return JournalService.reservationRecords(
      db(),
      rows.map((row) => row.id),
    )
  },

  async reservationRecords(executor: Executor, ids: string[]): Promise<JournalReservation[]> {
    if (ids.length === 0) return []
    const rows = await executor
      .select()
      .from(journalReservations)
      .where(inArray(journalReservations.id, ids))
      .orderBy(asc(journalReservations.year), asc(journalReservations.sequence))
    const people = await directory().refs([
      ...new Set(rows.map((row) => row.reservedBy).filter((v): v is string => !!v)),
    ])
    return rows.map((row) => ({
      id: row.id,
      journalId: row.journalId,
      number: row.number,
      sequence: row.sequence,
      year: row.year,
      note: row.note,
      state: row.state as JournalReservation['state'],
      reservedBy: row.reservedBy ? (people.get(row.reservedBy) ?? null) : null,
      reservedAt: row.reservedAt,
      documentId: row.documentId,
      usedAt: row.usedAt,
    }))
  },
}

async function assertTypes(executor: Executor, typeIds: string[]): Promise<void> {
  if (typeIds.length === 0) return
  const rows = await executor
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .where(inArray(documentTypes.id, typeIds))
  if (rows.length !== new Set(typeIds).size) {
    throw errors.validation('Тип документа не найден', [{ path: 'typeIds', message: 'type' }])
  }
}
