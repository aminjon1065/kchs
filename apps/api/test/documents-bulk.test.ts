import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Массовые действия в списке документов (ADR-0152): подшить выбранные в одно
 * дело, отправить на ознакомление, реестр выбранных в Excel. Каждый документ
 * проверяется сам: отказ по одному не отменяет остальных, итог говорит почему.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { readXlsx } = await import('../src/shared/xlsx.js')

const run = Date.now().toString(36)
const year = new Date().getFullYear()

let fx: TestContext
let registrar: TestUser
let clerk: TestUser
const types = new Map<string, string>()
let ministry = ''

interface BulkResult {
  done: string[]
  skipped: Array<{ id: string; title: string; reason: string }>
}

const get = (as: TestUser, url: string) => call(fx.app, { url, as })
const post = (as: TestUser, url: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url, as, payload })

async function draft(as: TestUser, typeKey: string, extra: Record<string, unknown> = {}) {
  const created = await post(as, '/documents', {
    typeId: types.get(typeKey),
    subject: `Документ ${run}`,
    ...extra,
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

/** Входящее со сканом, зарегистрированное делопроизводителем. */
async function registeredIncoming(subject: string, extra: Record<string, unknown> = {}) {
  const id = await draft(registrar, 'incoming_letter', {
    subject: `${subject} ${run}`,
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `05-11/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    ...extra,
  })
  const document = (await get(registrar, `/documents/${id}`)).json()
  const scan = await uploadFile(fx.app, registrar, {
    spaceId: document.spaceId,
    name: `скан-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 скан входящего письма',
    attachToObjectId: id,
  })
  expect(
    (await post(registrar, `/documents/${id}/versions`, { mainFileId: scan.id })).statusCode,
  ).toBe(200)
  const registered = await post(registrar, `/documents/${id}/register`)
  expect(registered.statusCode, registered.body).toBe(200)
  return id
}

async function bulk(as: TestUser, payload: Record<string, unknown>): Promise<BulkResult> {
  const response = await post(as, '/documents/bulk', payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, `registrar_bulk_${run}`, ['employee', 'registrar'])
  clerk = await createUser(fx.app, `clerk_bulk_${run}`, ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const typeList = await get(fx.admin, '/document-types')
  for (const item of typeList.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  ministry = (await get(registrar, '/correspondents?q=Минфин')).json().items[0].id
}, 120_000)

describe('массовые действия над документами', () => {
  it('подшивка: исполнимые — в дело, остальные пропущены с причиной, чужие не раскрываются', async () => {
    const created = await post(registrar, '/cases', {
      index: `40-${run}`,
      title: `Массовая подшивка ${run}`,
      year,
      retentionYears: 5,
    })
    expect(created.statusCode, created.body).toBe(200)
    const caseId = created.json().id as string

    const first = await registeredIncoming('О паводке')
    const second = await registeredIncoming('О селе')
    const onControl = await registeredIncoming('На контроле', {
      control: 'on',
      deadline: '2026-12-31',
    })
    const memo = await draft(registrar, 'memo', { subject: `Черновик записки ${run}` })
    const hidden = await draft(clerk, 'memo', { subject: `Чужой черновик ${run}` })

    const result = await bulk(registrar, {
      action: 'file',
      ids: [first, second, onControl, memo, hidden, first],
      caseId,
    })
    expect(result.done).toEqual([first, second])
    const skipped = new Map(result.skipped.map((item) => [item.id, item]))
    expect([...skipped.keys()].sort()).toEqual([onControl, memo, hidden].sort())
    expect(skipped.get(memo)?.title).toBe(`Черновик записки ${run}`)
    expect(skipped.get(memo)?.reason).not.toBe('')
    expect(skipped.get(onControl)?.reason).not.toBe('')
    // Документ, которого делопроизводитель не видит, не выдаёт даже названия
    expect(skipped.get(hidden)).toMatchObject({ title: '', reason: 'Документ недоступен' })

    for (const id of [first, second]) {
      const record = (await get(registrar, `/documents/${id}`)).json()
      expect(record).toMatchObject({ status: 'filed', case: { id: caseId } })
    }
    const state = (await get(registrar, `/documents/${memo}`)).json()
    expect(state.status).toBe('draft')

    // Сотрудник без права подшивать: всё пропущено, ничего не изменилось
    const third = await registeredIncoming('Третье')
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${third}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'user', id: clerk.id }, level: 'edit' }] },
    })
    const denied = await bulk(clerk, { action: 'file', ids: [third], caseId })
    expect(denied.done).toEqual([])
    expect(denied.skipped).toHaveLength(1)
    expect((await get(registrar, `/documents/${third}`)).json().status).not.toBe('filed')
  })

  it('ознакомление: адресаты получают запрос по каждому документу, повтор — без новых', async () => {
    const first = await registeredIncoming('Для ознакомления 1')
    const second = await registeredIncoming('Для ознакомления 2')
    const memo = await draft(registrar, 'memo', { subject: `Черновик для ознакомления ${run}` })
    const request = { userIds: [clerk.id], unitIds: [], groupIds: [] }

    const result = await bulk(registrar, {
      action: 'acknowledge',
      ids: [first, second, memo],
      request,
    })
    expect(result.done).toEqual([first, second])
    expect(result.skipped).toEqual([
      {
        id: memo,
        title: `Черновик для ознакомления ${run}`,
        reason: 'С документом знакомят после регистрации',
      },
    ])
    for (const id of [first, second]) {
      const view = (await get(registrar, `/objects/${id}/acknowledgments`)).json()
      expect(
        (view.items as Array<{ user: { id: string }; state: string }>).map((item) => [
          item.user.id,
          item.state,
        ]),
      ).toEqual([[clerk.id, 'pending']])
    }

    // Адресат уже ждёт: документ не меняется, причина — нет новых адресатов
    const again = await bulk(registrar, { action: 'acknowledge', ids: [first], request })
    expect(again.done).toEqual([])
    expect(again.skipped[0]?.reason).toMatch(/Новых адресатов нет/)

    // Без адресатов запрос не принимается целиком
    const empty = await post(registrar, '/documents/bulk', {
      action: 'acknowledge',
      ids: [first],
      request: { userIds: [], unitIds: [], groupIds: [] },
    })
    expect(empty.statusCode).toBe(400)
  })

  it('реестр в Excel: видимые документы по порядку, невидимые пропущены, выгрузка в журнале', async () => {
    const first = await registeredIncoming('Реестр 1')
    const second = await registeredIncoming('Реестр 2')
    const hidden = await draft(clerk, 'memo', { subject: `Невидимый ${run}` })

    const response = await get(
      registrar,
      `/documents/registry.xlsx?ids=${[second, hidden, first].join(',')}`,
    )
    expect(response.statusCode, response.body).toBe(200)
    expect(String(response.headers['content-type'])).toContain('spreadsheetml')
    const [sheet] = readXlsx((response as unknown as { rawPayload: Buffer }).rawPayload)
    expect(sheet?.name).toBe('Реестр')
    const [header, ...rows] = sheet?.rows ?? []
    expect(header?.slice(0, 5)).toEqual(['№ п/п', 'Рег. номер', 'Дата', 'Вид документа', 'Тема'])
    expect(rows.map((row) => [row[0], row[4]])).toEqual([
      ['1', `Реестр 2 ${run}`],
      ['2', `Реестр 1 ${run}`],
    ])
    // Регистрационный номер, корреспондент и исходящий номер отправителя
    expect(rows[0]?.[1]).not.toBe('')
    expect(rows[0]?.[6]).toBe(`05-11/${run} от 2026-09-15`)
    expect(rows.some((row) => row.includes(`Невидимый ${run}`))).toBe(false)

    const [logged] = await db().execute<{ details: { count: number; ids: string[] } }>(
      sql`SELECT details FROM audit_log WHERE action = 'document.registry_exported'
          AND actor_id = ${registrar.id} ORDER BY occurred_at DESC LIMIT 1`,
    )
    expect(logged?.details).toMatchObject({ count: 2, ids: [second, first] })

    // Список идентификаторов проверяется: не UUID — 400
    const broken = await get(registrar, '/documents/registry.xlsx?ids=not-a-uuid')
    expect(broken.statusCode).toBe(400)
  })
})
