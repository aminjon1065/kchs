import { and, eq, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeTelegram, startFakeTelegram, telegramCallback, telegramMessage } from './fakes.js'
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
import { actInbox, createPeople, inboxOf, type ProcessPeople, route } from './process-fixtures.js'

/**
 * Маршруты документов на движке процессов (P3-E02 S04, ADR-0083): стартовые
 * маршруты типов, запуск из карточки с выбором согласующих, статусы документа
 * по шагам, заморозка версии, замечания и повторное согласование только
 * отклонивших, сроки с праздником, подпись с кодом второго фактора и её
 * проверка по хэшу, регистрация шагом маршрута, эскалация без содержания,
 * согласование из Telegram, допуск к грифу, аннулирование возвращённого.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { BusinessCalendar } = await import('../src/kernel/business-calendar/service.js')
const { localDate } = await import('../src/kernel/business-calendar/working-days.js')
const { config, resetConfigCache } = await import('../src/shared/config/env.js')
const { fireStepTimers } = await import('../src/kernel/process/timers.js')
const { processSubscribers } = await import('../src/kernel/process/subscribers.js')
const { matchesType } = await import('../src/kernel/events/bus.js')
const { handleTelegramUpdate } = await import('../src/modules/telegram/domain/bot.js')
const schema = await import('../src/shared/db/schema/index.js')

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const run = Date.now().toString(36)

let fx: TestContext
let people: ProcessPeople
const types = new Map<string, string>()
let signerSecret = ''
let codeShift = 0

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

async function createDraft(
  as: TestUser,
  typeKey: string,
  extra: Record<string, unknown> = {},
): Promise<Body> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: types.get(typeKey), subject: `Документ ${run}`, ...extra },
  })
  expect(created.statusCode, created.body).toBe(200)
  return getDocument(as, created.json().id)
}

async function getDocument(as: TestUser, id: string): Promise<Body> {
  const response = await call(fx.app, { url: `/documents/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** Файл — вложение документа, затем версия с ним основным файлом. */
async function addVersion(as: TestUser, doc: Body, name: string) {
  const uploaded = await uploadFile(fx.app, as, {
    spaceId: doc.spaceId,
    name,
    mime: 'application/pdf',
    content: `%PDF-1.4 ${name}`,
    attachToObjectId: doc.id,
  })
  return call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as,
    payload: { mainFileId: uploaded.id },
  })
}

async function startRoute(as: TestUser, id: string, payload: Record<string, unknown>) {
  return call(fx.app, { method: 'POST', url: `/documents/${id}/routes`, as, payload })
}

/** Переходы статуса документа по событиям outbox — история в порядке событий. */
async function statusHistory(documentId: string): Promise<string[]> {
  const rows = await db().execute<{ to: string }>(
    sql`SELECT event->'payload'->>'to' AS to FROM ops.outbox
         WHERE event->>'type' = 'document.status_changed'
           AND event->'object'->>'id' = ${documentId}
         ORDER BY id`,
  )
  return rows.map((row) => row.to)
}

/** Подписчики движка по неопубликованным событиям outbox — как воркер. */
async function drainProcess(): Promise<void> {
  const subscribers = processSubscribers()
  for (let round = 0; round < 5; round++) {
    const rows = await db().execute<{ id: number; event: { type: string } }>(
      sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1000`,
    )
    if (rows.length === 0) return
    for (const row of rows) {
      for (const subscriber of subscribers) {
        if (!matchesType(subscriber.types, row.event.type)) continue
        await subscriber.handle(row.event as never)
      }
      await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
    }
  }
}

/** Второй фактор подписанта: код следующего окна — повтор кода отклоняется. */
async function signCode(): Promise<string> {
  if (!signerSecret) {
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: people.signer })
    signerSecret = setup.json().secret as string
    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: people.signer,
      payload: { code: authenticator.generate(signerSecret) },
    })
    expect(enable.statusCode, enable.body).toBe(200)
  }
  codeShift += 1
  return authenticator.clone({ epoch: Date.now() + codeShift * 30_000 }).generate(signerSecret)
}

beforeAll(async () => {
  fx = await setupFixture()
  people = await createPeople(fx, run)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
})

describe('стартовые маршруты', () => {
  it('опубликованы и назначены типам; сид повторно ничего не меняет', async () => {
    const again = await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
    expect(again.routes).toBe(0)
    const definitions = await call(fx.app, { url: '/process-definitions', as: fx.admin })
    const keys = (definitions.json().items as Array<{ key: string; publishedVersion: number }>)
      .filter((item) => item.key.startsWith('document_'))
      .map((item) => [item.key, item.publishedVersion])
    expect(keys).toEqual(
      expect.arrayContaining([
        ['document_outgoing', 1],
        ['document_order', 1],
        ['document_memo', 1],
      ]),
    )
    const list = await call(fx.app, { url: '/document-types', as: fx.admin })
    const routeOf = Object.fromEntries(
      (list.json().items as Array<{ key: string; defaultRouteKey: string | null }>).map((item) => [
        item.key,
        item.defaultRouteKey,
      ]),
    )
    expect(routeOf).toMatchObject({
      outgoing_letter: 'document_outgoing',
      order: 'document_order',
      memo: 'document_memo',
      incoming_letter: null,
    })
  })
})

describe('маршрут исходящего письма (сценарий фазы 3 №2)', () => {
  it('параллельно юрист и отдел, замечания, новая версия, повторно — только не одобривший; заместитель; подпись с кодом; регистрация', async () => {
    const doc = await createDraft(people.author, 'outgoing_letter', {
      subject: `Ответ Минфину ${run}`,
      signerId: people.signer.id,
    })
    expect(doc.can.startRoute).toBe(true)
    expect(doc.route).toBeNull()

    // Без версии маршрут не запустить; маршрут типа — первым
    let options = await call(fx.app, { url: `/documents/${doc.id}/routes`, as: people.author })
    expect(options.json()).toMatchObject({ canStart: false, blocker: 'no_version' })
    expect(options.json().items[0]).toMatchObject({
      key: 'document_outgoing',
      isDefault: true,
      choices: [{ stepKey: 'review', type: 'approval', required: true }],
    })
    const blocked = await startRoute(people.author, doc.id, {
      definitionKey: 'document_outgoing',
      assignees: { review: [people.a1.id, people.a2.id] },
    })
    expect(blocked.statusCode).toBe(409)
    expect((await addVersion(people.author, doc, `ответ-${run}-v1.pdf`)).statusCode).toBe(200)
    options = await call(fx.app, { url: `/documents/${doc.id}/routes`, as: people.author })
    expect(options.json()).toMatchObject({ canStart: true, blocker: null })
    // Посторонний не видит документ и его маршруты
    const foreign = await call(fx.app, {
      url: `/documents/${doc.id}/routes`,
      as: fx.users.stranger,
    })
    expect(foreign.statusCode).toBe(404)

    // Праздник на ближайший рабочий день: срок «3 рабочих дня» сдвигается
    const withoutHoliday = await BusinessCalendar.deadline(new Date(), 3)
    const holiday = await BusinessCalendar.addWorkingDays(localDate(new Date(), config().TZ), 1)
    await db().transaction((tx) =>
      BusinessCalendar.setDay(tx, systemCtx('test'), holiday, {
        kind: 'holiday',
        note: { ru: 'Тестовый праздник' },
      }),
    )
    const expectedDue = await BusinessCalendar.deadline(new Date(), 3)
    expect(expectedDue.date > withoutHoliday.date).toBe(true)

    // «Кто будет назначен»: выбор инициатора, заместитель по оргструктуре, подписант карточки
    const preview = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/routes/preview`,
      as: people.author,
      payload: {
        definitionKey: 'document_outgoing',
        assignees: { review: [people.a1.id, people.a2.id] },
      },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const assigned = Object.fromEntries(
      (preview.json().steps as Array<{ key: string; assignees: Array<{ user: { id: string } }> }>)
        .filter((step) => step.assignees.length > 0)
        .map((step) => [step.key, step.assignees.map((item) => item.user.id)]),
    )
    expect(assigned).toMatchObject({
      review: [people.a1.id, people.a2.id],
      deputy: [people.chief.id],
      sign: [people.signer.id],
      register: [people.registrar.id],
    })

    // Без выбора согласующих — не запустить
    const unchosen = await startRoute(people.author, doc.id, { definitionKey: 'document_outgoing' })
    expect(unchosen.statusCode).toBe(400)

    const started = await startRoute(people.author, doc.id, {
      definitionKey: 'document_outgoing',
      assignees: { review: [people.a1.id, people.a2.id] },
    })
    expect(started.statusCode, started.body).toBe(200)
    const instanceId = started.json().id as string

    let card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('on_approval')
    expect(card.can).toMatchObject({ startRoute: false, addVersion: false })
    expect(card.route).toMatchObject({ instanceId, definitionKey: 'document_outgoing', round: 1 })
    expect(card.route.steps).toEqual([
      expect.objectContaining({
        key: 'review',
        dueAt: expectedDue.dueAt.toISOString(),
        overdue: false,
        pending: expect.arrayContaining([
          expect.objectContaining({ id: people.a1.id }),
          expect.objectContaining({ id: people.a2.id }),
        ]),
      }),
    ])
    // Версия заморожена: окончательная, новую не добавить, пока идёт согласование
    const versions = await call(fx.app, { url: `/documents/${doc.id}/versions`, as: people.author })
    expect(versions.json().items[0]).toMatchObject({ number: 1, isFinal: true })
    const late = await addVersion(people.author, doc, `ответ-${run}-поздно.pdf`)
    expect(late.statusCode).toBe(409)

    // Участник идущего шага видит и обсуждает документ; посторонний — нет
    expect((await call(fx.app, { url: `/documents/${doc.id}`, as: people.a1 })).statusCode).toBe(
      200,
    )
    const question = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc.id}/discussion/messages`,
      as: people.a2,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Есть ли приложение к письму?',
      },
    })
    expect(question.statusCode, question.body).toBe(200)
    expect(
      (await call(fx.app, { url: `/documents/${doc.id}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)
    // Список документов участника шага — по политике типа
    const listed = await call(fx.app, {
      url: `/objects?type=document&limit=200`,
      as: people.a1,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    expect((listed.json().items as Array<{ id: string }>).map((item) => item.id)).toContain(doc.id)

    // a1 согласует, a2 даёт замечания — возврат автору
    const [a1Item] = await inboxOf(fx, people.a1, doc.id)
    expect(a1Item?.dueAt).toBe(expectedDue.dueAt.toISOString())
    expect((await actInbox(fx, people.a1, a1Item?.id ?? '', 'approve')).statusCode).toBe(200)
    const [a2Item] = await inboxOf(fx, people.a2, doc.id)
    const remarks = await actInbox(fx, people.a2, a2Item?.id ?? '', 'remarks', {
      comment: 'Добавьте ссылку на договор',
    })
    expect(remarks.statusCode, remarks.body).toBe(200)
    card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('returned')
    expect(card.route.steps).toEqual([
      expect.objectContaining({
        key: 'return_to_author',
        pending: [expect.objectContaining({ id: people.author.id })],
      }),
    ])
    // Возвращённый — новая версия и повторная отправка
    expect(card.can.addVersion).toBe(true)
    expect((await addVersion(people.author, doc, `ответ-${run}-v2.pdf`)).statusCode).toBe(200)
    const [revise] = await inboxOf(fx, people.author, doc.id)
    expect(revise?.kind).toBe('revise')
    expect((await actInbox(fx, people.author, revise?.id ?? '', 'resubmit')).statusCode).toBe(200)

    card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('on_approval')
    expect(card.route.round).toBe(2)
    let view = await route(fx, people.author, instanceId)
    const second = view.steps.find(
      (step: { key: string; round: number }) => step.key === 'review' && step.round === 2,
    )
    expect(
      Object.fromEntries(
        second.assignees.map((item: { user: { id: string }; state: string }) => [
          item.user.id,
          item.state,
        ]),
      ),
    ).toEqual({ [people.a1.id]: 'carried', [people.a2.id]: 'pending' })
    expect(await inboxOf(fx, people.a1, doc.id)).toEqual([])
    // Каждый круг согласования видел свою версию
    const stepVersions = await call(fx.app, {
      url: `/documents/${doc.id}/route-versions`,
      as: people.author,
    })
    const reviewVersions = view.steps
      .filter((step: { key: string }) => step.key === 'review')
      .map(
        (step: { id: string }) =>
          (stepVersions.json().items as Array<{ stepId: string; versionNumber: number }>).find(
            (item) => item.stepId === step.id,
          )?.versionNumber,
      )
    expect(reviewVersions).toEqual([1, 2])

    // a2 согласует → заместитель (руководитель руководителя подразделения автора)
    const [again] = await inboxOf(fx, people.a2, doc.id)
    expect((await actInbox(fx, people.a2, again?.id ?? '', 'approve')).statusCode).toBe(200)
    const [deputyItem] = await inboxOf(fx, people.chief, doc.id)
    expect(deputyItem?.kind).toBe('approve')
    expect((await actInbox(fx, people.chief, deputyItem?.id ?? '', 'approve')).statusCode).toBe(200)
    card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('on_signing')

    // Подпись: только с кодом второго фактора
    const [signItem] = await inboxOf(fx, people.signer, doc.id)
    expect(signItem?.actions[0]).toMatchObject({ key: 'sign', requiresSecondFactor: true })
    const code = await signCode()
    const signed = await actInbox(fx, people.signer, signItem?.id ?? '', 'sign', {
      payload: { code },
    })
    expect(signed.statusCode, signed.body).toBe(200)
    card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('signed')

    // Подпись: версия 2, код подтверждён; хэш ждёт отчёта движка
    let signatures = await call(fx.app, {
      url: `/documents/${doc.id}/signatures`,
      as: people.author,
    })
    expect(signatures.json().items).toEqual([
      expect.objectContaining({
        signer: expect.objectContaining({ id: people.signer.id }),
        versionNumber: 2,
        mfa: true,
        kind: 'simple',
        state: 'pending',
        current: true,
        hash: null,
      }),
    ])
    const versionId = signatures.json().items[0].versionId as string
    const sha = 'a'.repeat(64)
    const report = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/internal/documents/versions/${versionId}/pdf`,
      headers: { 'x-kchs-service-token': token },
      payload: { status: 'skipped', sha256: sha },
    })
    expect(report.statusCode, report.body).toBe(200)
    signatures = await call(fx.app, { url: `/documents/${doc.id}/signatures`, as: people.author })
    expect(signatures.json().items[0]).toMatchObject({ hash: sha, state: 'valid' })

    // Регистрация канцелярией из Входящих — номер исходящего журнала
    const [registerItem] = await inboxOf(fx, people.registrar, doc.id)
    expect(registerItem?.kind).toBe('register')
    const registered = await actInbox(fx, people.registrar, registerItem?.id ?? '', 'register')
    expect(registered.statusCode, registered.body).toBe(200)
    card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('registered')
    expect(card.regNumber).toMatch(/^ИСХ-\d{4}\/\d{2}$/)
    expect(card.registration.registeredBy.id).toBe(people.registrar.id)
    expect(card.route).toBeNull()
    view = await route(fx, people.author, instanceId)
    expect(view).toMatchObject({ status: 'finished', outcome: 'completed' })

    expect(await statusHistory(doc.id)).toEqual([
      'on_approval',
      'returned',
      'on_approval',
      'approved',
      'on_signing',
      'signed',
      'registered',
    ])
    // Участник завершённого шага сохраняет просмотр
    expect((await call(fx.app, { url: `/documents/${doc.id}`, as: people.a2 })).statusCode).toBe(
      200,
    )
  })

  it('через общее API движка — те же проверки карточки', async () => {
    const doc = await createDraft(people.author, 'order', { signerId: people.signer.id })
    const noVersion = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.author,
      payload: {
        objectId: doc.id,
        definitionKey: 'document_order',
        assignees: { review: [people.a1.id] },
      },
    })
    expect(noVersion.statusCode).toBe(409)
    await addVersion(people.author, doc, `приказ-${run}.pdf`)
    const notMine = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.a1,
      payload: { objectId: doc.id, definitionKey: 'document_order' },
    })
    expect(notMine.statusCode).toBe(404)
    const started = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.author,
      payload: {
        objectId: doc.id,
        definitionKey: 'document_order',
        assignees: { review: [people.a1.id] },
      },
    })
    expect(started.statusCode, started.body).toBe(200)
    expect((await getDocument(people.author, doc.id)).status).toBe('on_approval')
  })
})

describe('подпись без согласования и автоматическая регистрация', () => {
  it('служебная записка: подпись руководителя подразделения, номер — сразу после подписи', async () => {
    const doc = await createDraft(people.author, 'memo', { subject: `Записка ${run}` })
    await addVersion(people.author, doc, `записка-${run}.pdf`)
    const started = await startRoute(people.author, doc.id, { definitionKey: 'document_memo' })
    expect(started.statusCode, started.body).toBe(200)
    expect((await getDocument(people.author, doc.id)).status).toBe('on_signing')
    const [item] = await inboxOf(fx, people.boss, doc.id)
    expect(item?.actions.map((action) => [action.key, action.requiresSecondFactor])).toEqual([
      ['sign', false],
      ['refuse', false],
    ])
    expect((await actInbox(fx, people.boss, item?.id ?? '', 'sign')).statusCode).toBe(200)
    const card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('registered')
    expect(card.regNumber).toMatch(/^ВН-\d{4}\/\d{2}$/)
    expect(await statusHistory(doc.id)).toEqual(['on_signing', 'signed', 'registered'])
  })

  it('отказ в подписи возвращает автору; возвращённый документ аннулируется, маршрут отзывается', async () => {
    const doc = await createDraft(people.author, 'memo', { subject: `Отказ ${run}` })
    await addVersion(people.author, doc, `отказ-${run}.pdf`)
    const started = await startRoute(people.author, doc.id, { definitionKey: 'document_memo' })
    expect(started.statusCode, started.body).toBe(200)
    const [item] = await inboxOf(fx, people.boss, doc.id)
    const refused = await actInbox(fx, people.boss, item?.id ?? '', 'refuse', {
      comment: 'Не по форме',
    })
    expect(refused.statusCode, refused.body).toBe(200)
    let card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('returned')
    expect(card.can.cancel).toBe(true)

    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/cancel`,
      as: people.author,
      payload: { reason: 'Записка больше не нужна' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    card = cancelled.json()
    expect(card.status).toBe('cancelled')
    expect(card.route).toBeNull()
    const view = await route(fx, people.author, started.json().id)
    expect(view).toMatchObject({ status: 'cancelled', outcome: 'withdrawn' })
    expect(await inboxOf(fx, people.author, doc.id)).toEqual([])
  })
})

describe('эскалация', () => {
  it('просрочка шага: согласующему — «просрочено», руководителю без доступа — без содержания, автору — с названием', async () => {
    const doc = await createDraft(people.author, 'order', {
      subject: `Приказ о дежурстве ${run}`,
      signerId: people.signer.id,
    })
    await addVersion(people.author, doc, `дежурство-${run}.pdf`)
    const started = await startRoute(people.author, doc.id, {
      definitionKey: 'document_order',
      assignees: { review: [people.a3.id] },
    })
    expect(started.statusCode, started.body).toBe(200)
    const view = await route(fx, people.author, started.json().id)
    const review = view.steps.find((step: { key: string }) => step.key === 'review')
    await drainProcess()
    // Срок прошёл: таймеры шага срабатывают по состоянию в базе
    const fired = await fireStepTimers(review.id, new Date(Date.parse(review.dueAt) + 60_000))
    expect(fired).toBeGreaterThan(0)
    await drainProcess()

    const notes = await db()
      .select({
        userId: schema.notifications.userId,
        titleKey: schema.notifications.titleKey,
        objectId: schema.notifications.objectId,
        params: schema.notifications.params,
      })
      .from(schema.notifications)
      .where(
        and(
          sql`${schema.notifications.titleKey} LIKE 'notifications.tpl.process%'`,
          sql`${schema.notifications.createdAt} > now() - interval '5 minutes'`,
        ),
      )
    const of = (userId: string) => notes.filter((note) => note.userId === userId)
    expect(of(people.a3.id).map((note) => note.titleKey)).toContain(
      'notifications.tpl.processOverdue',
    )
    // Руководитель согласующего документ не видит: без названия и ссылки на объект
    const hidden = of(people.boss.id).find(
      (note) => note.titleKey === 'notifications.tpl.processEscalationHidden',
    )
    expect(hidden).toMatchObject({ objectId: null })
    expect(JSON.stringify(hidden?.params)).not.toContain('дежурстве')
    expect(hidden?.params).toMatchObject({ people: expect.stringContaining('Тестов') })
    // Автор видит документ — обычная эскалация
    expect(
      of(people.author.id).find((note) => note.titleKey === 'notifications.tpl.processEscalation'),
    ).toMatchObject({ objectId: doc.id })
  })
})

describe('допуск к грифу', () => {
  it('согласующий без допуска к «конфиденциально» не назначается', async () => {
    const clearance = await call(fx.app, {
      method: 'PUT',
      url: `/users/${people.author.id}/clearance`,
      as: fx.admin,
      payload: { clearance: 'confidential', reason: 'Допуск для проверки маршрута' },
    })
    expect(clearance.statusCode, clearance.body).toBe(200)
    const doc = await createDraft(people.author, 'order', {
      subject: `Конфиденциальный приказ ${run}`,
      signerId: people.signer.id,
      confidentiality: 'confidential',
    })
    await addVersion(people.author, doc, `конф-${run}.pdf`)
    const started = await startRoute(people.author, doc.id, {
      definitionKey: 'document_order',
      assignees: { review: [people.a1.id] },
    })
    expect(started.statusCode).toBe(409)
    expect(started.json().detail).toContain('допуска')
    expect((await getDocument(people.author, doc.id)).status).toBe('draft')
  })
})

describe('согласование из Telegram (сценарий фазы 3 №3)', () => {
  let telegram: FakeTelegram
  const chat = 5550077
  let nextUpdate = 1

  const configure = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetConfigCache()
  }

  beforeAll(async () => {
    telegram = await startFakeTelegram()
    configure({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_API_URL: telegram.url })
  })

  afterAll(async () => {
    configure({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_API_URL: undefined })
    await telegram?.close()
  })

  it('кнопка «Согласовать» в уведомлении о шаге; подписать из Telegram нельзя', async () => {
    const approver = await createUser(fx.app, `tg_approver_${run}`, ['employee'], fx.unitId)
    const link = await call(fx.app, { method: 'POST', url: '/me/telegram/link', as: approver })
    expect(link.statusCode, link.body).toBe(200)
    const startToken = new URL(link.json().url as string).searchParams.get('start') ?? ''
    await handleTelegramUpdate(
      telegramMessage(nextUpdate++, { id: chat }, `/start ${startToken}`) as never,
    )

    const doc = await createDraft(people.author, 'order', {
      subject: `Приказ по Telegram ${run}`,
      signerId: people.signer.id,
    })
    await addVersion(people.author, doc, `тг-${run}.pdf`)
    const started = await startRoute(people.author, doc.id, {
      definitionKey: 'document_order',
      assignees: { review: [approver.id] },
    })
    expect(started.statusCode, started.body).toBe(200)

    const before = telegram.sent().length
    await drainProcess()
    const sent = telegram.sent().slice(before)
    const message = sent.find((item) => item.chatId === chat)
    expect(message?.text).toContain('Согласуйте')
    type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }
    const buttons = ((message?.markup as Keyboard | undefined)?.inline_keyboard ?? [])
      .flat()
      .filter((button) => button.callback_data)
    expect(buttons.map((button) => button.text)).toEqual(['Согласовать', 'Замечания', 'Отклонить'])

    await handleTelegramUpdate(
      telegramCallback(nextUpdate++, chat, buttons[0]?.callback_data ?? '') as never,
    )
    const card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('on_signing')
    const view = await route(fx, people.author, started.json().id)
    const review = view.steps.find((step: { key: string }) => step.key === 'review')
    expect(review.assignees[0]).toMatchObject({ state: 'approved' })

    // Подпись требует кода — в Telegram её кнопки нет
    const [signItem] = await inboxOf(fx, people.signer, doc.id)
    expect(signItem?.kind).toBe('sign')
    const rows = await db()
      .select({ id: schema.inboxItems.id })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.objectId, doc.id), eq(schema.inboxItems.kind, 'sign')))
    expect(rows.length).toBeGreaterThan(0)
  })
})
