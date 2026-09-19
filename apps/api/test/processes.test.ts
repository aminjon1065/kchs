import { and, eq, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  uploadFile,
} from './helpers.js'
import {
  actInbox,
  activeStep,
  createDocument,
  createPeople,
  inboxOf,
  moduleCalls,
  type ProcessPeople,
  publishDefinition,
  registerTestModule,
  route,
  startProcess,
  TEST_TYPE,
} from './process-fixtures.js'

/**
 * Движок процессов (P3-E01 S02, ADR-0079): определения с версиями, запуск,
 * параллельное согласование с замечаниями и повторным согласованием только
 * отклонивших, сроки в рабочих днях с праздником, подпись с подтверждением
 * вторым фактором, регистрация модулем, замещение, состав назначенных,
 * права участников, ожидание, условия, отмена и корзина.
 */
registerLifecycle()

const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
const { processSubscribers } = await import('../src/kernel/process/subscribers.js')
const { activitySubscriber } = await import('../src/kernel/activity/service.js')
const { BusinessCalendar } = await import('../src/kernel/business-calendar/service.js')
const { localDate } = await import('../src/kernel/business-calendar/working-days.js')
const { config } = await import('../src/shared/config/index.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { ProcessService } = await import('../src/kernel/process/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const schema = await import('../src/shared/db/schema/index.js')
const { GroupService } = await import('../src/modules/identity/public.js')
const { newId } = await import('../src/shared/ids.js')

let fx: TestContext
let people: ProcessPeople
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  registerTestModule()
  people = await createPeople(fx, run)
})

/** Подписчики движка по неопубликованным событиям outbox — как воркер. */
async function drain(): Promise<void> {
  const subscribers = [...processSubscribers(), activitySubscriber]
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
  expect(listSubscribers).toBeDefined()
}

async function notificationsOf(userId: string, objectId: string) {
  return db()
    .select({ titleKey: schema.notifications.titleKey })
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.userId, userId), eq(schema.notifications.objectId, objectId)),
    )
}

/** Маршрут документа: параллельное согласование → подпись с MFA → регистрация. */
function documentRoute(key: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    key,
    objectType: TEST_TYPE(),
    name: { ru: 'Исходящее письмо', en: 'Outgoing letter' },
    variables: {
      reviewers: { type: 'users', label: { ru: 'Согласующие' }, required: true },
      signer: { type: 'user', label: { ru: 'Подписант' }, required: true },
    },
    start: 'review',
    steps: {
      review: {
        type: 'approval',
        name: { ru: 'Согласование' },
        mode: 'parallel',
        quorum: 'all',
        assignees: ['var:reviewers'],
        dueWorkingDays: 3,
        onReject: 'back',
        allowAddApprover: true,
        next: 'sign',
      },
      sign: {
        type: 'sign',
        name: { ru: 'Подпись' },
        assignees: ['var:signer'],
        requireMfa: true,
        dueWorkingDays: 2,
        onReject: 'back',
        next: 'register',
      },
      register: {
        type: 'register',
        name: { ru: 'Регистрация' },
        assignees: ['role:registrar'],
        journal: 'outgoing',
        next: 'end',
      },
      back: { type: 'return', to: 'author', reapproval: 'rejecters_only', next: 'review' },
      end: { type: 'end' },
    },
    timers: [{ step: '*', onOverdue: [{ action: 'notify', to: 'manager(step.assignee)' }] }],
    ...extra,
  }
}

describe('определения маршрутов', () => {
  it('справочник конструктора: типы с поставщиком и полями, события ожидания, исполнители шагов (ADR-0087)', async () => {
    const denied = await call(fx.app, { url: '/process-catalog', as: people.author })
    expect(denied.statusCode).toBe(403)
    const response = await call(fx.app, { url: '/process-catalog', as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const catalog = response.json()
    expect(catalog.objectTypes).toEqual(
      expect.arrayContaining([
        {
          type: TEST_TYPE(),
          canStart: true,
          fields: [
            { path: 'amount', label: { ru: 'Сумма', en: 'Amount' }, type: 'money' },
            { path: 'signer', label: { ru: 'Подписант', en: 'Signer' }, type: 'user' },
          ],
        },
      ]),
    )
    expect(catalog.waitEvents).toEqual(
      expect.arrayContaining(['object.updated', 'process.finished']),
    )
    expect(catalog.handlers).toEqual(
      expect.arrayContaining([
        { type: 'register', objectType: TEST_TYPE(), action: null },
        { type: 'task', objectType: null, action: null },
        { type: 'call', objectType: null, action: 'test.dispatch' },
      ]),
    )

    // Назначенные в конструкторе — именами: ключи принципалов раскрываются, мусор пропускается
    const keys = [`user:${people.boss.id}`, `unit:${fx.unitId}`, 'role:registrar', 'user:42', 'x']
    const described = await call(fx.app, {
      url: `/principals/describe?keys=${encodeURIComponent(keys.join(','))}`,
      as: fx.admin,
    })
    expect(described.statusCode, described.body).toBe(200)
    const items = described.json().items as Array<{ type: string; id: string; title: string }>
    expect(items.map((item) => `${item.type}:${item.id}`).sort()).toEqual(
      [`unit:${fx.unitId}`, `user:${people.boss.id}`].sort(),
    )
    expect(items.every((item) => item.title.length > 0)).toBe(true)
  })

  it('черновик, проверка, публикация; новая версия не трогает идущий экземпляр', async () => {
    const key = `defs_${run}`
    const bad = await call(fx.app, {
      method: 'POST',
      url: '/process-definitions',
      as: fx.admin,
      payload: { definition: { ...documentRoute(key), start: 42 } },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().data.issues[0]).toMatchObject({ path: 'start', code: 'schema' })

    const validate = await call(fx.app, {
      method: 'POST',
      url: '/process-definitions/validate',
      as: fx.admin,
      payload: {
        definition: {
          ...documentRoute(key),
          steps: {
            ...documentRoute(key).steps,
            register: { type: 'register', assignees: ['role:registrar'], next: 'nowhere' },
            extra: { type: 'call', action: 'unknown.action', next: 'end' },
          },
        },
      },
    })
    expect(validate.statusCode).toBe(200)
    expect(validate.json().ok).toBe(false)
    const codes = validate.json().issues.map((issue: { code: string }) => issue.code)
    expect(codes).toEqual(
      expect.arrayContaining(['unknown_step', 'unreachable', 'handler_missing']),
    )

    // Сотрудник без способности маршрутов в определения не заходит
    const denied = await call(fx.app, { url: '/process-definitions', as: people.author })
    expect(denied.statusCode).toBe(403)

    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Письмо v1 ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id], signer: people.signer.id },
    })

    // Версия 2: добавлено ознакомление перед регистрацией
    const v2 = documentRoute(key)
    ;(v2.steps as Record<string, unknown>).sign = { ...v2.steps.sign, next: 'ack' }
    ;(v2.steps as Record<string, unknown>).ack = {
      type: 'acknowledge',
      assignees: ['author'],
      next: 'register',
    }
    const draft = await call(fx.app, {
      method: 'PUT',
      url: `/process-definitions/${key}/draft`,
      as: fx.admin,
      payload: { definition: v2 },
    })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json().version.version).toBe(2)
    expect(draft.json().version.publishedAt).toBeNull()
    const published = await call(fx.app, {
      method: 'POST',
      url: `/process-definitions/${key}/publish`,
      as: fx.admin,
    })
    expect(published.statusCode, published.body).toBe(200)

    const details = await call(fx.app, { url: `/process-definitions/${key}`, as: fx.admin })
    expect(details.json().published.version).toBe(2)
    expect(details.json().draft).toBeNull()
    expect(
      details
        .json()
        .versions.map((item: { version: number; running: number }) => [item.version, item.running]),
    ).toEqual([
      [2, 0],
      [1, 1],
    ])

    const view = await route(fx, people.author, instanceId)
    expect(view.version).toBe(1)
    expect(Object.keys(view.definition.steps)).not.toContain('ack')

    const second = await createDocument(fx, people.author, `Письмо v2 ${run}`)
    const next = await startProcess(fx, people.author, {
      objectId: second,
      definitionKey: key,
      variables: { reviewers: [people.a1.id], signer: people.signer.id },
    })
    expect((await route(fx, people.author, next)).version).toBe(2)

    // Второй запуск того же маршрута для объекта — конфликт
    const again = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.author,
      payload: {
        objectId: doc,
        definitionKey: key,
        variables: { reviewers: [people.a1.id], signer: people.signer.id },
      },
    })
    expect(again.statusCode).toBe(409)
  })

  it('предпросмотр: кто будет назначен, условие запуска, сроки', async () => {
    const key = `preview_${run}`
    const definition = {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Предпросмотр' },
      start: 'legal',
      steps: {
        legal: {
          type: 'approval',
          assignees: ['unit_head(author.unit)', 'manager(unit_head(author.unit))'],
          dueWorkingDays: 2,
          next: 'end',
        },
        end: { type: 'end' },
      },
      conditions: [
        {
          if: 'object.fields.amount > 1000000',
          insertBefore: 'end',
          step: { type: 'approval', assignees: ['role:registrar', 'previous_step.assignees'] },
        },
      ],
    }
    const doc = await createDocument(fx, people.author, `Предпросмотр ${run}`, {
      amount: 2_000_000,
    })
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/process-definitions/preview',
      as: fx.admin,
      payload: { definition, objectId: doc },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const body = preview.json()
    expect(body.issues.filter((issue: { severity: string }) => issue.severity === 'error')).toEqual(
      [],
    )
    expect(body.conditions).toEqual([
      { index: 0, key: 'cond_1', insertBefore: 'end', matched: true, error: null },
    ])
    const legal = body.steps.find((step: { key: string }) => step.key === 'legal')
    expect(legal.assignees.map((item: { user: { id: string } }) => item.user.id)).toEqual([
      people.boss.id,
      people.chief.id,
    ])
    expect(legal.dueAt).toBeTruthy()
    const inserted = body.steps.find((step: { key: string }) => step.key === 'cond_1')
    expect(inserted.inserted).toBe(true)
    expect(inserted.issues).toEqual([
      expect.objectContaining({ expression: 'previous_step.assignees', code: 'runtime' }),
    ])
  })
})

describe('маршрут документа', () => {
  it('параллельное согласование с замечаниями, возврат и повторное согласование только отклонивших; срок с праздником; подпись с MFA; регистрация', async () => {
    const key = `letter_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Исходящее ${run}`)

    // Праздник на ближайший рабочий день: срок «3 рабочих дня» сдвигается на день
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

    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: {
        reviewers: [people.a1.id, people.a2.id, people.a3.id],
        signer: people.signer.id,
      },
    })

    // Каждому согласующему — элемент Входящих со сроком по календарю
    const [a1Item] = await inboxOf(fx, people.a1, doc)
    expect(a1Item).toMatchObject({ kind: 'approve', dueAt: expectedDue.dueAt.toISOString() })
    expect(a1Item?.actions.map((action) => action.key)).toEqual(['approve', 'remarks', 'reject'])

    // Участник шага видит объект по политике типа, посторонний — нет
    const asApprover = await call(fx.app, { url: `/objects/${doc}`, as: people.a1 })
    expect(asApprover.statusCode).toBe(200)
    const asStranger = await call(fx.app, { url: `/objects/${doc}`, as: fx.users.stranger })
    expect(asStranger.statusCode).toBe(404)
    expect(
      (await call(fx.app, { url: `/processes/${instanceId}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)

    // a1 согласует во Входящих, a2 — замечания во Входящих, a3 — замечания через API
    expect((await actInbox(fx, people.a1, a1Item?.id ?? '', 'approve')).statusCode).toBe(200)
    const [a2Item] = await inboxOf(fx, people.a2, doc)
    const noComment = await actInbox(fx, people.a2, a2Item?.id ?? '', 'remarks')
    expect(noComment.statusCode).toBe(400)
    const remarks = await actInbox(fx, people.a2, a2Item?.id ?? '', 'remarks', {
      comment: 'Уточните сроки поставки',
    })
    expect(remarks.statusCode, remarks.body).toBe(200)
    let view = await route(fx, people.author, instanceId)
    const review = activeStep(view, 'review')
    expect(review.dueAt).toBe(expectedDue.dueAt.toISOString())
    // Замечания ждут ответа всех: шаг ещё идёт
    const a3Act = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/act`,
      as: people.a3,
      payload: { action: 'remarks', comment: 'Нет ссылки на договор' },
    })
    expect(a3Act.statusCode, a3Act.body).toBe(200)

    view = await route(fx, people.author, instanceId)
    const first = view.steps.find((step: { key: string }) => step.key === 'review')
    expect(first.outcome).toBe('remarks')
    expect(
      first.actions.map((action: { action: string; comment: string | null }) => [
        action.action,
        action.comment,
      ]),
    ).toEqual([
      ['approve', null],
      ['remarks', 'Уточните сроки поставки'],
      ['remarks', 'Нет ссылки на договор'],
    ])
    expect(activeStep(view, 'back').assignees[0].user.id).toBe(people.author.id)
    expect(view.myActions).toEqual([
      expect.objectContaining({ stepKey: 'back', actions: ['resubmit', 'withdraw'] }),
    ])

    // Автор доработал и отправил повторно из Входящих
    const [revise] = await inboxOf(fx, people.author, doc)
    expect(revise?.kind).toBe('revise')
    expect((await actInbox(fx, people.author, revise?.id ?? '', 'resubmit')).statusCode).toBe(200)
    view = await route(fx, people.author, instanceId)
    expect(view.round).toBe(2)
    const second = activeStep(view, 'review')
    expect(
      Object.fromEntries(
        second.assignees.map((item: { user: { id: string }; state: string }) => [
          item.user.id,
          item.state,
        ]),
      ),
    ).toEqual({ [people.a1.id]: 'carried', [people.a2.id]: 'pending', [people.a3.id]: 'pending' })
    // Одобривший в первом круге повторно не согласует
    expect(await inboxOf(fx, people.a1, doc)).toEqual([])

    for (const person of [people.a2, people.a3]) {
      const [item] = await inboxOf(fx, person, doc)
      expect((await actInbox(fx, person, item?.id ?? '', 'approve')).statusCode).toBe(200)
    }

    // Подпись: без кода — отказ; с подключённым вторым фактором — подписано
    const [signItem] = await inboxOf(fx, people.signer, doc)
    expect(signItem?.actions).toEqual([
      expect.objectContaining({ key: 'sign', requiresSecondFactor: true }),
      expect.objectContaining({ key: 'refuse', requiresComment: true }),
    ])
    const noMfa = await actInbox(fx, people.signer, signItem?.id ?? '', 'sign', {
      payload: { code: '123456' },
    })
    expect(noMfa.statusCode).toBe(422)
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: people.signer })
    const secret = setup.json().secret as string
    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: people.signer,
      payload: { code: authenticator.generate(secret) },
    })
    expect(enable.statusCode).toBe(200)
    const missing = await actInbox(fx, people.signer, signItem?.id ?? '', 'sign')
    expect(missing.statusCode).toBe(400)
    const wrong = await actInbox(fx, people.signer, signItem?.id ?? '', 'sign', {
      payload: { code: '000000' },
    })
    expect(wrong.statusCode).toBe(400)
    const code = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret)
    const signed = await actInbox(fx, people.signer, signItem?.id ?? '', 'sign', {
      payload: { code },
    })
    expect(signed.statusCode, signed.body).toBe(200)

    // Регистратор регистрирует — номер даёт модуль
    const [registerItem] = await inboxOf(fx, people.registrar, doc)
    expect(registerItem?.kind).toBe('register')
    expect(
      (await actInbox(fx, people.registrar, registerItem?.id ?? '', 'register')).statusCode,
    ).toBe(200)

    view = await route(fx, people.author, instanceId)
    expect(view.status).toBe('finished')
    expect(view.outcome).toBe('completed')
    const registered = view.steps.find((step: { key: string }) => step.key === 'register')
    expect(registered.result.number).toMatch(/^ИСХ-\d+\/26$/)
    const signedStep = view.steps.find((step: { key: string }) => step.key === 'sign')
    expect(signedStep.actions[0]).toMatchObject({ action: 'sign' })

    // Хуки модуля: активации, решения, завершения
    expect(moduleCalls.finished).toContainEqual({ status: 'finished', outcome: 'completed' })
    expect(moduleCalls.completed).toEqual(
      expect.arrayContaining([
        'review:remarks',
        'back:resubmitted',
        'review:approved',
        'sign:signed',
      ]),
    )

    // Аудит решения с подтверждением вторым фактором
    const auditRows = await db()
      .select({ details: schema.auditLog.details, actorId: schema.auditLog.actorId })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.objectId, doc), eq(schema.auditLog.action, 'process.decision')))
    expect(auditRows).toHaveLength(8)
    expect(
      auditRows.find((row) => (row.details as { decision?: string }).decision === 'sign')?.details,
    ).toMatchObject({
      mfa: true,
    })

    // Замечания — сообщения-решения в обсуждении документа
    const messages = await db().execute<{ kind: string; text: string }>(
      sql`SELECT m.kind, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.object_id = ${doc} ORDER BY m.id`,
    )
    expect(messages.map((row) => [row.kind, row.text])).toEqual([
      ['decision', 'Уточните сроки поставки'],
      ['decision', 'Нет ссылки на договор'],
    ])

    // Уведомления и лента — подписчики событий
    await drain()
    const authorNotes = await notificationsOf(people.author.id, doc)
    expect(authorNotes.map((row) => row.titleKey)).toEqual(
      expect.arrayContaining([
        'notifications.tpl.processRemarks',
        'notifications.tpl.processRevise',
        'notifications.tpl.processFinished',
      ]),
    )
    const activity = await db()
      .select({ key: sql<string>`${schema.activities.summary}->>'key'` })
      .from(schema.activities)
      .where(eq(schema.activities.objectId, doc))
    expect(activity.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        'activity.process.started',
        'activity.process.decided.remarks',
        'activity.process.decided.sign',
        'activity.process.finished',
      ]),
    )
    // Участник завершённого шага сохраняет просмотр (afterStep: view)
    expect((await call(fx.app, { url: `/objects/${doc}`, as: people.a2 })).statusCode).toBe(200)
  })

  it('отклонение подписи возвращает автору; согласование засчитано, подпись — заново', async () => {
    const key = `refuse_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Отказ ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id], signer: people.boss.id },
    })
    const [item] = await inboxOf(fx, people.a1, doc)
    await actInbox(fx, people.a1, item?.id ?? '', 'approve')
    const [sign] = await inboxOf(fx, people.boss, doc)
    const refuse = await actInbox(fx, people.boss, sign?.id ?? '', 'refuse', {
      comment: 'Не тот бланк',
    })
    expect(refuse.statusCode, refuse.body).toBe(200)
    const [revise] = await inboxOf(fx, people.author, doc)
    await actInbox(fx, people.author, revise?.id ?? '', 'resubmit')
    const view = await route(fx, people.author, instanceId)
    expect(activeStep(view, 'sign').assignees[0].user.id).toBe(people.boss.id)
    expect(
      view.steps
        .filter((step: { key: string }) => step.key === 'review')
        .map((step: { outcome: string }) => step.outcome),
    ).toEqual(['approved', 'approved'])
  })

  it('замещение: копия Входящих заместителю, решение от имени, аудит', async () => {
    const key = `deputy_${run}`
    await publishDefinition(fx, documentRoute(key))
    const delegation = await call(fx.app, {
      method: 'POST',
      url: '/me/delegations',
      as: people.a1,
      payload: {
        toUserId: people.deputy.id,
        scope: 'approvals',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    expect(delegation.statusCode, delegation.body).toBe(200)
    const doc = await createDocument(fx, people.author, `Замещение ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id, people.a2.id], signer: people.signer.id },
    })
    const [copy] = await inboxOf(fx, people.deputy, doc)
    expect(copy?.onBehalfOf?.id).toBe(people.a1.id)
    const acted = await actInbox(fx, people.deputy, copy?.id ?? '', 'approve')
    expect(acted.statusCode, acted.body).toBe(200)
    // Дело замещаемого закрыто вместе с копией
    expect(await inboxOf(fx, people.a1, doc)).toEqual([])

    const view = await route(fx, people.author, instanceId)
    const review = activeStep(view, 'review')
    const a1 = review.assignees.find(
      (item: { user: { id: string } }) => item.user.id === people.a1.id,
    )
    expect(a1).toMatchObject({ state: 'approved', actor: { id: people.deputy.id } })
    expect(review.actions[0]).toMatchObject({
      actor: { id: people.deputy.id },
      onBehalfOf: { id: people.a1.id },
    })
    const [row] = await db()
      .select({ actorId: schema.auditLog.actorId, onBehalfOf: schema.auditLog.onBehalfOf })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.objectId, doc), eq(schema.auditLog.action, 'process.decision')))
    expect(row).toEqual({ actorId: people.deputy.id, onBehalfOf: people.a1.id })

    // Замещение снято — копий больше не будет
    const [delegated] = (await call(fx.app, { url: '/me/delegations', as: people.a1 }))
      .json()
      .items.filter((item: { toUser: { id: string } }) => item.toUser.id === people.deputy.id)
    await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${delegated.id}`,
      as: people.a1,
    })
  })

  it('добавить согласующего и передать шаг', async () => {
    const key = `members_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Состав ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id, people.a2.id], signer: people.signer.id },
    })
    let review = activeStep(await route(fx, people.author, instanceId), 'review')
    const added = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/assignees`,
      as: people.a1,
      payload: { userId: people.a3.id },
    })
    expect(added.statusCode, added.body).toBe(200)
    // Не участник шага добавить не может
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/assignees`,
      as: people.author,
      payload: { userId: people.deputy.id },
    })
    expect(foreign.statusCode).toBe(403)
    const delegated = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/delegate`,
      as: people.a2,
      payload: { userId: people.deputy.id, comment: 'В отпуске' },
    })
    expect(delegated.statusCode, delegated.body).toBe(200)
    expect(await inboxOf(fx, people.a2, doc)).toEqual([])
    expect((await inboxOf(fx, people.deputy, doc)).map((item) => item.kind)).toEqual(['approve'])
    expect((await inboxOf(fx, people.a3, doc)).map((item) => item.kind)).toEqual(['approve'])
    review = activeStep(await route(fx, people.author, instanceId), 'review')
    expect(
      review.assignees.map((item: { user: { id: string }; state: string }) => [
        item.user.id,
        item.state,
      ]),
    ).toEqual([
      [people.a1.id, 'pending'],
      [people.a3.id, 'pending'],
      [people.a2.id, 'delegated'],
      [people.deputy.id, 'pending'],
    ])
    // Все, включая добавленного и получившего шаг, решают — шаг завершён
    for (const person of [people.a1, people.a3, people.deputy]) {
      const [item] = await inboxOf(fx, person, doc)
      expect((await actInbox(fx, person, item?.id ?? '', 'approve')).statusCode).toBe(200)
    }
    expect(activeStep(await route(fx, people.author, instanceId), 'sign')).toBeTruthy()
  })
})

describe('исполнение', () => {
  it('условие запуска, шаги модуля (call, task), изменение поля, ожидание события', async () => {
    const key = `auto_${run}`
    await publishDefinition(fx, {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Автоматические шаги' },
      start: 'first',
      steps: {
        first: { type: 'approval', assignees: ['author'], next: 'mark' },
        mark: { type: 'set', field: 'status', value: 'approved', next: 'send' },
        send: {
          type: 'call',
          action: 'test.dispatch',
          params: { channel: 'mail' },
          next: 'hold',
        },
        hold: {
          type: 'wait',
          event: 'object.updated',
          filter: "event.object.title = 'Готово'",
          next: 'job',
        },
        job: {
          type: 'task',
          title: { ru: 'Отправить' },
          assignees: ['unit_head(author.unit)'],
          dueWorkingDays: 1,
          next: 'tell',
        },
        tell: { type: 'notify', to: 'author', next: 'end' },
        end: { type: 'end', outcome: 'sent' },
      },
      conditions: [
        {
          if: "object.fields.amount > 1000000 and object.typeKey = 'letter'",
          insertBefore: 'mark',
          key: 'finance',
          step: { type: 'approval', assignees: ['manager(unit_head(author.unit))'] },
        },
      ],
    })
    const doc = await createDocument(fx, people.author, `Автоматика ${run}`, { amount: 5_000_000 })
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    const [mine] = await inboxOf(fx, people.author, doc)
    await actInbox(fx, people.author, mine?.id ?? '', 'approve')
    // Условие запуска вставило согласование руководителя руководителя
    const [finance] = await inboxOf(fx, people.chief, doc)
    expect(finance?.kind).toBe('approve')
    await actInbox(fx, people.chief, finance?.id ?? '', 'approve')

    let view = await route(fx, people.author, instanceId)
    expect(activeStep(view, 'hold')).toBeTruthy()
    const [object] = await db()
      .select({ meta: schema.objects.meta })
      .from(schema.objects)
      .where(eq(schema.objects.id, doc))
    expect(object?.meta).toMatchObject({ status: 'approved' })
    expect(moduleCalls.calls).toContainEqual({
      action: 'test.dispatch',
      params: { channel: 'mail' },
    })

    // Событие, не прошедшее фильтр, ожидание не завершает
    await db().transaction((tx) =>
      ObjectService.update(tx, systemCtx('test'), doc, { title: 'Черновик' }),
    )
    await drain()
    expect(activeStep(await route(fx, people.author, instanceId), 'hold')).toBeTruthy()
    await db().transaction((tx) =>
      ObjectService.update(tx, systemCtx('test'), doc, { title: 'Готово' }),
    )
    await drain()
    view = await route(fx, people.author, instanceId)
    const job = activeStep(view, 'job')
    expect(job.assignees).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: people.boss.id }),
        state: 'assigned',
      }),
    ])
    const task = moduleCalls.tasks.find((item) => item.stepId === job.id)
    expect(task?.assignees).toEqual([people.boss.id])
    expect(task?.dueAt).toBeTruthy()

    // Модуль сообщает: поручение исполнено
    await db().transaction((tx) =>
      ProcessService.completeStep(tx, systemCtx('test'), {
        stepId: job.id,
        result: { taskId: 'T-1' },
      }),
    )
    view = await route(fx, people.author, instanceId)
    expect(view.status).toBe('finished')
    expect(view.outcome).toBe('sent')
    await drain()
    expect((await notificationsOf(people.author.id, doc)).map((row) => row.titleKey)).toContain(
      'notifications.tpl.processNotify',
    )
  })

  it('решать некому: запуск — ошибка; на ходу — переназначение администратором', async () => {
    const key = `empty_${run}`
    await publishDefinition(fx, {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Пустые назначения' },
      variables: { who: { type: 'users', label: { ru: 'Кто' } } },
      start: 'first',
      steps: {
        first: { type: 'approval', assignees: ['var:who'], next: 'second' },
        second: { type: 'approval', assignees: ['role:nobody_has_it'], next: 'end' },
        end: { type: 'end' },
      },
    })
    const doc = await createDocument(fx, people.author, `Пусто ${run}`)
    const failed = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.author,
      payload: { objectId: doc, definitionKey: key },
    })
    expect(failed.statusCode).toBe(400)
    expect(failed.json().errors[0]).toMatchObject({ path: 'steps.first', code: 'no_assignees' })

    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { who: [people.a1.id] },
    })
    const [item] = await inboxOf(fx, people.a1, doc)
    await actInbox(fx, people.a1, item?.id ?? '', 'approve')
    let view = await route(fx, people.author, instanceId)
    const second = activeStep(view, 'second')
    expect(second.unassigned).toBe(true)
    await drain()
    expect((await notificationsOf(people.author.id, doc)).map((row) => row.titleKey)).toContain(
      'notifications.tpl.processUnassigned',
    )
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${second.id}/reassign`,
      as: people.author,
      payload: { userIds: [people.a2.id] },
    })
    expect(denied.statusCode).toBe(403)
    const reassigned = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${second.id}/reassign`,
      as: fx.admin,
      payload: { userIds: [people.a2.id] },
    })
    expect(reassigned.statusCode, reassigned.body).toBe(200)
    const [a2] = await inboxOf(fx, people.a2, doc)
    await actInbox(fx, people.a2, a2?.id ?? '', 'approve')
    view = await route(fx, people.author, instanceId)
    expect(view.status).toBe('finished')
  })

  it('отмена маршрута и корзина объекта закрывают Входящие', async () => {
    const key = `cancel_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Отмена ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id], signer: people.signer.id },
    })
    expect(await inboxOf(fx, people.a1, doc)).toHaveLength(1)
    // Посторонний отменить не может и маршрута не видит
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/cancel`,
      as: fx.users.stranger,
      payload: {},
    })
    expect(stranger.statusCode).toBe(404)
    // Участник шага видит маршрут, но отменить не может
    const approver = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/cancel`,
      as: people.a1,
      payload: {},
    })
    expect(approver.statusCode).toBe(403)
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/cancel`,
      as: people.author,
      payload: { reason: 'Передумали' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(await inboxOf(fx, people.a1, doc)).toEqual([])
    expect((await route(fx, people.author, instanceId)).status).toBe('cancelled')

    // Корзина: идущий маршрут второго документа отменяется подписчиком
    const trashed = await createDocument(fx, people.author, `Корзина ${run}`)
    const second = await startProcess(fx, people.author, {
      objectId: trashed,
      definitionKey: key,
      variables: { reviewers: [people.a2.id], signer: people.signer.id },
    })
    await db().transaction((tx) => ObjectService.trash(tx, systemCtx('test'), trashed))
    await drain()
    const [instance] = await db()
      .select({ status: schema.processInstances.status, outcome: schema.processInstances.outcome })
      .from(schema.processInstances)
      .where(eq(schema.processInstances.id, second))
    expect(instance).toEqual({ status: 'cancelled', outcome: 'object_trashed' })
    const open = await db()
      .select({ id: schema.inboxItems.id })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.objectId, trashed), eq(schema.inboxItems.state, 'open')))
    expect(open).toEqual([])
  })

  it('права: маршрут видит тот, кто видит объект; решает только назначенный', async () => {
    const key = `rights_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Права ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id], signer: people.signer.id },
    })
    const review = activeStep(await route(fx, people.author, instanceId), 'review')
    // Читатель пространства видит маршрут, но решать не может
    expect(
      (await call(fx.app, { url: `/processes?objectId=${doc}`, as: fx.users.viewer })).json().items,
    ).toHaveLength(1)
    const viewer = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/act`,
      as: fx.users.viewer,
      payload: { action: 'approve' },
    })
    expect(viewer.statusCode).toBe(403)
    // Посторонний не узнаёт о шаге
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/act`,
      as: fx.users.stranger,
      payload: { action: 'approve' },
    })
    expect(stranger.statusCode).toBe(404)
    // Шаг из чужого маршрута по адресу этого — 404
    const wrongRoute = await call(fx.app, {
      method: 'POST',
      url: `/processes/${review.id}/steps/${review.id}/act`,
      as: people.a1,
      payload: { action: 'approve' },
    })
    expect(wrongRoute.statusCode).toBe(404)
    // Объекты без поставщика с запуском маршрутов из API не запускаются
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: people.author,
      payload: { name: `Папка ${run}`, spaceId: fx.spaceId },
    })
    const started = await call(fx.app, {
      method: 'POST',
      url: '/processes',
      as: people.author,
      payload: { objectId: folder.json().id, definitionKey: key },
    })
    expect(started.statusCode).toBe(403)
    // Поиск: участник шага — в принципалах документа
    const principals = await import('../src/kernel/access/acl-service.js').then((module) =>
      module.readPrincipalsFor(doc),
    )
    expect(principals).toContain(`user:${people.a1.id}`)
  })

  it('назначения по оргструктуре: подразделение, группа, роли в пространстве и без ограничения', async () => {
    // Роль «юрист»: ограниченная тестовым пространством — у a1, без ограничения — у a2
    const legal = newId()
    await db()
      .insert(schema.roles)
      .values({ id: legal, key: `legal_${run}`, name: { ru: 'Юрист' } })
    await db()
      .insert(schema.userRoles)
      .values([
        { userId: people.a1.id, roleId: legal, spaceId: fx.spaceId },
        { userId: people.a2.id, roleId: legal, spaceId: null },
      ])
    const group = await db().transaction((tx) => GroupService.create(tx, `Юристы ${run}`))
    await db().transaction((tx) =>
      GroupService.setMembers(tx, group, [people.a3.id, people.deputy.id]),
    )
    const definition = {
      version: 1,
      key: `org_${run}`,
      objectType: TEST_TYPE(),
      name: { ru: 'Оргструктура' },
      start: 'unit',
      steps: {
        unit: { type: 'acknowledge', assignees: [`unit:${fx.unitId}`], next: 'group' },
        group: { type: 'approval', assignees: [`group:${group}`], next: 'space' },
        space: { type: 'approval', assignees: ['role_in_space:editor'], next: 'legal' },
        legal: { type: 'approval', assignees: [`role_in_space:legal_${run}`], next: 'any' },
        any: { type: 'approval', assignees: [`role:legal_${run}`], next: 'end' },
        end: { type: 'end' },
      },
    }
    const preview = async (objectId: string) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/process-definitions/preview',
        as: fx.admin,
        payload: { definition, objectId },
      })
      expect(response.statusCode, response.body).toBe(200)
      return Object.fromEntries(
        response
          .json()
          .steps.map((step: { key: string; assignees: Array<{ user: { id: string } }> }) => [
            step.key,
            step.assignees.map((item) => item.user.id).sort(),
          ]),
      ) as Record<string, string[]>
    }
    const inSpace = await createDocument(fx, people.author, `Оргструктура ${run}`)
    const byKey = await preview(inSpace)
    // Подразделение — со всеми сотрудниками (глава, согласующие, подписант, заместитель, автор)
    expect(byKey.unit).toEqual(
      [
        people.author.id,
        people.boss.id,
        people.a1.id,
        people.a2.id,
        people.a3.id,
        people.signer.id,
        people.deputy.id,
      ].sort(),
    )
    expect(byKey.group).toEqual([people.a3.id, people.deputy.id].sort())
    // Роль участника пространства — «не ниже»: редактор и администратор пространства
    expect(byKey.space).toEqual([fx.admin.id, people.author.id].sort())
    expect(byKey.legal).toEqual([people.a1.id])
    expect(byKey.any).toEqual([people.a1.id, people.a2.id].sort())

    // Объект в другом пространстве: юриста пространства нет — юрист без ограничения
    const other = await db().transaction((tx) =>
      ObjectService.create(tx, systemCtx('test', { initiatorId: people.author.id }), {
        type: TEST_TYPE() as never,
        spaceId: fx.orgSpaceId,
        title: `Другое пространство ${run}`,
        ownerId: people.author.id,
      }),
    )
    const outside = await preview(other.id)
    expect(outside.legal).toEqual([people.a2.id])
    expect(outside.any).toEqual([people.a2.id])
  })

  it('замечания с файлом: файл — вложение документа, решение — в обсуждении; чужой файл — нельзя', async () => {
    const key = `files_${run}`
    await publishDefinition(fx, documentRoute(key))
    const doc = await createDocument(fx, people.author, `Замечания с файлом ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a1.id, people.a2.id], signer: people.signer.id },
    })
    const review = activeStep(await route(fx, people.author, instanceId), 'review')
    const personal = async (user: typeof people.a1) =>
      (await call(fx.app, { url: '/me', as: user })).json().personalSpaceId as string
    const own = await uploadFile(fx.app, people.a1, {
      spaceId: await personal(people.a1),
      name: `правки-${run}.txt`,
      content: 'Правки к пункту 3',
    })
    const foreign = await uploadFile(fx.app, people.a2, {
      spaceId: await personal(people.a2),
      name: `чужой-${run}.txt`,
      content: 'не для вложения',
    })
    // Чужой файл приложить нельзя — решение не принято
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/act`,
      as: people.a1,
      payload: { action: 'remarks', fileIds: [foreign.id] },
    })
    expect(denied.statusCode).toBe(404)
    const accepted = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${review.id}/act`,
      as: people.a1,
      payload: { action: 'remarks', fileIds: [own.id] },
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    // Автор видит файл замечаний как вложение документа
    expect((await call(fx.app, { url: `/objects/${own.id}`, as: people.author })).statusCode).toBe(
      200,
    )
    const view = await route(fx, people.author, instanceId)
    const step = view.steps.find((item: { id: string }) => item.id === review.id)
    expect(step.actions).toEqual([
      expect.objectContaining({ action: 'remarks', comment: null, fileIds: [own.id] }),
    ])
    const [message] = await db().execute<{ kind: string; attachments: Array<{ fileId: string }> }>(
      sql`SELECT m.kind, m.attachments FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.object_id = ${doc}`,
    )
    expect(message?.kind).toBe('decision')
    expect(message?.attachments.map((item) => item.fileId)).toEqual([own.id])
  })

  it('«от имени» через API: только в пределах области замещения', async () => {
    const key = `scope_${run}`
    await publishDefinition(fx, documentRoute(key))
    const delegate = async (scope: string) =>
      (
        await call(fx.app, {
          method: 'POST',
          url: '/me/delegations',
          as: people.a3,
          payload: {
            toUserId: people.signer.id,
            scope,
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        })
      ).json().id as string
    const narrow = await delegate('instructions')
    const doc = await createDocument(fx, people.author, `Область замещения ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { reviewers: [people.a3.id], signer: people.boss.id },
    })
    const review = activeStep(await route(fx, people.author, instanceId), 'review')
    const act = () =>
      call(fx.app, {
        method: 'POST',
        url: `/processes/${instanceId}/steps/${review.id}/act`,
        as: people.signer,
        headers: { 'x-kchs-on-behalf-of': people.a3.id },
        payload: { action: 'approve' },
      })
    // Поручения — не согласования: замещение на шаг не распространяется
    expect((await act()).statusCode).toBe(403)
    await call(fx.app, { method: 'DELETE', url: `/me/delegations/${narrow}`, as: people.a3 })
    await delegate('approvals')
    const ok = await act()
    expect(ok.statusCode, ok.body).toBe(200)
    const view = await route(fx, people.author, instanceId)
    const decided = view.steps.find((item: { id: string }) => item.id === review.id)
    expect(decided.assignees[0]).toMatchObject({
      user: { id: people.a3.id },
      state: 'approved',
      actor: { id: people.signer.id },
    })
  })
})
