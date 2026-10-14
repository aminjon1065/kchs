import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Порт государственной системы ЭДО (ADR-0206): без адаптера отправка не ставится,
 * с адаптером — очередь с повторами по нарастающей паузе, отказ без повтора, ключ
 * идемпотентности, события и канал `edms` в журнале подключений.
 */
registerLifecycle()

const { edmsSends, integrationUsageDaily, outbox } = await import('../src/db-schema.js')
const edms = await import('../src/modules/integrations/domain/edms.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let documentId = ''

const PACKAGE = {
  regNumber: '03-12/145',
  regDate: '2026-10-12',
  subject: 'О паводковой обстановке',
  typeKey: 'outgoing_letter',
  files: [],
  signatures: [],
}

beforeAll(async () => {
  fx = await setupFixture()
  documentId = await db().transaction(async (tx) => {
    const object = await ObjectService.create(tx, systemCtx('test', { initiatorId: fx.admin.id }), {
      type: 'journal',
      spaceId: fx.spaceId,
      title: 'Объект отправки',
      meta: {},
    })
    return object.id
  })
})

// По умолчанию — ручной обмен с закрытой госсистемой (ADR-0219)
afterAll(() => edms.registerEdmsExchange(edms.MANUAL_EDMS))

const ctx = () => systemCtx('test', { initiatorId: fx.admin.id })

async function sendRow(id: string) {
  const [row] = await db().select().from(edmsSends).where(eq(edmsSends.id, id))
  return row
}

async function events(type: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(outbox)
    .where(sql`${outbox.event}->>'type' = ${type}`)
  return row?.total ?? 0
}

describe('порт ЭДО (ADR-0206)', () => {
  it('без адаптера отправка не ставится в очередь', async () => {
    edms.registerEdmsExchange(null)
    await expect(
      db().transaction((tx) =>
        edms.EdmsSends.enqueue(tx, ctx(), {
          documentId,
          versionNo: 1,
          recipient: 'MINFIN',
          payload: PACKAGE,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await edms.EdmsSends.processDue()).toEqual({ sent: 0, retried: 0, failed: 0 })
  })

  it('неудача — повтор с паузой, затем отправка; ключ идемпотентности не плодит отправки', async () => {
    let calls = 0
    edms.registerEdmsExchange({
      name: 'Тестовая ЭДО',
      send: async (input) => {
        calls += 1
        if (calls === 1) throw new Error('503 Service Unavailable')
        return { externalId: `ext-${input.sendId.slice(0, 8)}`, status: 'sent' }
      },
    })
    const enqueue = () =>
      db().transaction((tx) =>
        edms.EdmsSends.enqueue(tx, ctx(), {
          documentId,
          versionNo: 1,
          recipient: 'MINFIN',
          payload: PACKAGE,
        }),
      )
    const id = await enqueue()
    expect(await enqueue()).toBe(id)
    expect(await events('edms.send_queued')).toBe(1)

    expect(await edms.EdmsSends.processDue()).toEqual({ sent: 0, retried: 1, failed: 0 })
    const retry = await sendRow(id)
    expect(retry).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: '503 Service Unavailable',
    })
    // Повтор — не раньше паузы
    expect(await edms.EdmsSends.processDue()).toEqual({ sent: 0, retried: 0, failed: 0 })

    const later = new Date(Date.now() + 2 * 60_000)
    expect(await edms.EdmsSends.processDue(later)).toEqual({ sent: 1, retried: 0, failed: 0 })
    const sent = await sendRow(id)
    expect(sent).toMatchObject({ status: 'sent', attempts: 2, error: null })
    expect(sent?.externalId).toMatch(/^ext-/)
    expect(await events('edms.sent')).toBe(1)

    const [usage] = await db()
      .select()
      .from(integrationUsageDaily)
      .where(eq(integrationUsageDaily.channel, 'edms'))
    expect(usage).toMatchObject({ requests: 1, errors: 1 })
  })

  it('отказ без повтора сразу проваливает отправку', async () => {
    edms.registerEdmsExchange({
      name: 'Тестовая ЭДО',
      send: async () => {
        throw new edms.EdmsError('Адресат не найден', false)
      },
    })
    const id = await db().transaction((tx) =>
      edms.EdmsSends.enqueue(tx, ctx(), {
        documentId,
        versionNo: 2,
        recipient: 'UNKNOWN',
        payload: PACKAGE,
      }),
    )
    expect(await edms.EdmsSends.processDue()).toEqual({ sent: 0, retried: 0, failed: 1 })
    expect(await sendRow(id)).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await events('edms.send_failed')).toBe(1)
  })
})
