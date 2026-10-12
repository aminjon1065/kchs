import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { type EdmsSendRow, edmsSends } from '../schema.js'
import { recordUsage } from './usage.js'

/**
 * Порт государственной системы электронного документооборота (ADR-0206, пункт 10
 * плана 08-architecture-concept-note-and-signatures.md). Интерфейса системы пока нет,
 * поэтому реализации нет: есть только порт, очередь отправок с повторами и учёт канала
 * `edms` в журнале подключений. До появления адаптера обмен идёт исходящим письмом
 * с подписанным экземпляром (ADR-0198).
 *
 * Адаптер регистрирует себя `registerEdmsExchange` и объявляет расписание задания
 * `EDMS_DISPATCH_JOB` (обработчик уже зарегистрирован модулем); модуль документов
 * собирает пакет отправки и ставит её `EdmsSends.enqueue` в своей транзакции.
 */

/** Файл отправки: версия документа или подписанный экземпляр. */
export interface EdmsFile {
  name: string
  mime: string
  /** Ключ объекта хранилища — адаптер читает содержимое сам. */
  storageKey: string
  sha256: string
  size: number
}

/** Пакет отправки — то, что модуль документов знает о документе. */
export interface EdmsPackage {
  regNumber: string | null
  regDate: string | null
  subject: string
  /** Тип документа по ключу справочника (ADR-0206). */
  typeKey: string | null
  files: EdmsFile[]
  /** Подписи версии: кто, когда, вид — для реквизитов в системе адресата. */
  signatures: Array<{ signer: string; signedAt: string; kind: string }>
}

export interface EdmsOutgoing {
  sendId: string
  documentId: string
  versionNo: number | null
  recipient: string
  idempotencyKey: string
  payload: EdmsPackage
}

export interface EdmsSendResult {
  /** Идентификатор документа в системе ЭДО. */
  externalId: string
  /** `sent` — принят системой, `delivered` — получен адресатом. */
  status: 'sent' | 'delivered'
}

/** Порт: всё, что платформа ждёт от адаптера государственной системы ЭДО. */
export interface EdmsExchange {
  /** Название системы — для журнала и интерфейса. */
  name: string
  /**
   * Отправка пакета. Повтор с тем же ключом идемпотентности не должен создавать
   * второй документ у адресата. Ошибка с `retryable: false` повторами не лечится.
   */
  send(input: EdmsOutgoing): Promise<EdmsSendResult>
  /** Состояние отправки у адресата — для отправок в состоянии `sent`. */
  status?(externalId: string): Promise<'sent' | 'delivered' | 'rejected'>
  /** Адресаты из справочника организаций системы. */
  recipients?(query: string): Promise<Array<{ code: string; name: string }>>
}

/** Ошибка адаптера: `retryable: false` — повторять бесполезно (адресат неизвестен, отказ). */
export class EdmsError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'EdmsError'
  }
}

let adapter: EdmsExchange | null = null

export function registerEdmsExchange(exchange: EdmsExchange | null): void {
  adapter = exchange
}

export const EDMS_DISPATCH_JOB = {
  queue: 'maintenance',
  name: 'integrations.edms-dispatch',
} as const

/** Паузы перед повторами, мин: после восьмой неудачи отправка считается проваленной. */
const RETRY_MINUTES = [1, 5, 15, 60, 180, 720, 1440] as const
export const EDMS_MAX_ATTEMPTS = RETRY_MINUTES.length + 1

const eventObject = (row: { documentId: string }) => ({ id: row.documentId, type: 'document' })

export const EdmsSends = {
  /**
   * Ставит отправку в очередь в транзакции вызывающего. Без адаптера отказывает:
   * отправка, которую некому выполнить, не должна висеть «в очереди» молча.
   */
  async enqueue(
    tx: Tx,
    ctx: Ctx,
    input: {
      documentId: string
      versionNo: number | null
      recipient: string
      payload: EdmsPackage
      idempotencyKey?: string
    },
  ): Promise<string> {
    if (!adapter) {
      throw errors.conflict('Обмен с государственной системой ЭДО не подключён', {
        reason: 'edms_not_configured',
      })
    }
    const id = newId()
    const idempotencyKey =
      input.idempotencyKey ?? `${input.documentId}:${input.versionNo ?? 0}:${input.recipient}`
    const [existing] = await tx
      .select({ id: edmsSends.id })
      .from(edmsSends)
      .where(eq(edmsSends.idempotencyKey, idempotencyKey))
      .limit(1)
    if (existing) return existing.id
    await tx.insert(edmsSends).values({
      id,
      documentId: input.documentId,
      versionNo: input.versionNo,
      recipient: input.recipient,
      idempotencyKey,
      payload: input.payload as unknown as Record<string, unknown>,
      status: 'pending',
      nextAttemptAt: sql`now()`,
      createdById: ctx.kind === 'user' ? ctx.userId : (ctx.initiatorId ?? null),
    })
    await publishEvent(tx, ctx, {
      type: 'edms.send_queued',
      object: eventObject(input),
      payload: { sendId: id, recipient: input.recipient, versionNo: input.versionNo },
    })
    return id
  },

  /**
   * Задание очереди: отправки, чей срок подошёл, уходят адаптеру; неудача — повтор
   * с нарастающей паузой, после последней — `failed`. Строки берутся с блокировкой
   * `SKIP LOCKED`, так что два воркера одну отправку не возьмут.
   */
  async processDue(
    now = new Date(),
    limit = 20,
  ): Promise<{ sent: number; retried: number; failed: number }> {
    const result = { sent: 0, retried: 0, failed: 0 }
    const exchange = adapter
    if (!exchange) return result
    const due = await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(edmsSends)
        .where(
          and(eq(edmsSends.status, 'pending'), lte(edmsSends.nextAttemptAt, now.toISOString())),
        )
        .orderBy(asc(edmsSends.nextAttemptAt))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (rows.length === 0) return []
      // Взятые отправки откладываются на время попытки: упавший воркер их не потеряет
      await tx
        .update(edmsSends)
        .set({ nextAttemptAt: sql`now() + interval '10 minutes'` })
        .where(
          inArray(
            edmsSends.id,
            rows.map((row) => row.id),
          ),
        )
      return rows
    })
    for (const row of due) {
      const outcome = await attempt(exchange, row)
      result[outcome] += 1
    }
    return result
  },
}

async function attempt(
  exchange: EdmsExchange,
  row: EdmsSendRow,
): Promise<'sent' | 'retried' | 'failed'> {
  const ctx = systemCtx('edms')
  const attempts = row.attempts + 1
  const at = new Date()
  try {
    const sent = await exchange.send({
      sendId: row.id,
      documentId: row.documentId,
      versionNo: row.versionNo,
      recipient: row.recipient,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload as unknown as EdmsPackage,
    })
    await db().transaction(async (tx) => {
      await tx
        .update(edmsSends)
        .set({
          status: sent.status,
          attempts,
          externalId: sent.externalId,
          error: null,
          nextAttemptAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(edmsSends.id, row.id))
      await publishEvent(tx, ctx, {
        type: 'edms.sent',
        object: eventObject(row),
        payload: { sendId: row.id, externalId: sent.externalId, attempts },
      })
      await recordUsage(tx, [edmsUsage(row, exchange, at, { requests: 1, errors: 0 })])
    })
    return 'sent'
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
    const final = attempts >= EDMS_MAX_ATTEMPTS || (error instanceof EdmsError && !error.retryable)
    const delay = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] ?? 60
    await db().transaction(async (tx) => {
      await tx
        .update(edmsSends)
        .set({
          status: final ? 'failed' : 'pending',
          attempts,
          error: message,
          nextAttemptAt: final ? null : sql`now() + ${`${delay} minutes`}::interval`,
          updatedAt: sql`now()`,
        })
        .where(eq(edmsSends.id, row.id))
      if (final) {
        await publishEvent(tx, ctx, {
          type: 'edms.send_failed',
          object: eventObject(row),
          payload: { sendId: row.id, attempts, error: message },
        })
      }
      await recordUsage(tx, [
        { ...edmsUsage(row, exchange, at, { requests: 0, errors: 1 }), error: message },
      ])
    })
    logger()
      .child({ module: 'integrations' })
      .warn({ sendId: row.id, attempts, final }, 'отправка в ЭДО не удалась')
    return final ? 'failed' : 'retried'
  }
}

/**
 * Подключение канала `edms` в журнале подключений — сама система ЭДО: адресатов
 * в реестре объектов нет, поэтому id постоянный.
 */
const EDMS_CONNECTION_ID = '00000000-0000-4000-8000-0000000ed050'

/** Передача в систему ЭДО для журнала подключений. */
function edmsUsage(
  _row: EdmsSendRow,
  exchange: EdmsExchange,
  at: Date,
  counts: { requests: number; errors: number },
) {
  return {
    subjectId: EDMS_CONNECTION_ID,
    channel: 'edms' as const,
    kind: 'integration' as const,
    title: exchange.name,
    rows: 0,
    at,
    ...counts,
  }
}
