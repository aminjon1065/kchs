import type { RuleRunRecord } from '@kchs/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Правила автоматизации (P5-E02, ADR-0096): создание и проверка определения,
 * исполнение по событию настоящей шиной и воркером, границы служебного
 * пользователя, защита от циклов, ручной запуск, тестовый прогон и экран
 * «Расписания».
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { startWorkers, stopWorkers } = await import('../src/kernel/jobs/runner.js')
const { registerAutomationBackground, scheduleAutomationJobs } = await import(
  '../src/modules/automation/module.js'
)
const { scheduleMaintenance } = await import('../src/kernel/jobs/maintenance.js')
const { RuleRuns } = await import('../src/modules/automation/domain/runs.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let previousSubscribers: Subscriber[] = []
const run = Date.now().toString(36)
/** Служебные учётные записи (ADR-0130): правила работают только от их имени. */
let bot: { id: string }
let outsider: { id: string }

async function serviceAccount(
  name: string,
  spaces: Array<{ spaceId: string; role: 'viewer' | 'member' | 'editor' }>,
): Promise<{ id: string }> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/service-accounts',
    as: fx.admin,
    payload: { name, roleKeys: ['employee'], spaces },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { id: string }
}

interface RuleInput {
  name: string
  runAs: string
  trigger: Record<string, unknown>
  conditions?: unknown
  actions: Array<Record<string, unknown>>
  enabled?: boolean
  limits?: Record<string, unknown>
  spaceId?: string
}

async function createRule(input: RuleInput, as = fx.admin) {
  return call(fx.app, {
    method: 'POST',
    url: '/automation/rules',
    as,
    payload: {
      spaceId: input.spaceId ?? fx.spaceId,
      definition: {
        name: { ru: input.name },
        runAs: input.runAs,
        enabled: input.enabled ?? true,
        trigger: input.trigger,
        conditions: input.conditions ?? null,
        actions: input.actions,
        ...(input.limits ? { limits: input.limits } : {}),
      },
    },
  })
}

async function createFolder(name: string, spaceId = fx.spaceId): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

async function runsOf(ruleId: string): Promise<RuleRunRecord[]> {
  const response = await call(fx.app, { url: `/automation/rules/${ruleId}/runs`, as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

const FINISHED = ['succeeded', 'failed', 'skipped']

/** Ждёт завершённый запуск правила и проверяет его исход. */
async function waitForRun(
  ruleId: string,
  statuses: string[],
  timeoutMs = 25_000,
): Promise<RuleRunRecord> {
  const started = Date.now()
  let last: RuleRunRecord | undefined
  while (Date.now() - started < timeoutMs) {
    const items = await runsOf(ruleId)
    const found = items.find((item) => statuses.includes(item.status))
    if (found) return found
    last = items.find((item) => FINISHED.includes(item.status)) ?? last
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(
    `запуск правила ${ruleId} со статусом ${statuses.join('|')} не дождался; ` +
      `последний: ${last?.status ?? 'нет'} ${last?.error ?? ''} ${JSON.stringify(last?.steps ?? [])}`,
  )
}

/** Названия тегов объекта: карточка объекта отдаёт их вместе с реквизитами. */
async function tagsOf(objectId: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/objects/${objectId}`, as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().tags as Array<{ name: string }>).map((tag) => tag.name)
}

beforeAll(async () => {
  fx = await setupFixture()
  // Робот пространства правит в нём объекты, посторонний робот доступа не имеет
  bot = await serviceAccount(`Робот ${run}`, [{ spaceId: fx.spaceId, role: 'editor' }])
  outsider = await serviceAccount(`Посторонний робот ${run}`, [])
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  registerAutomationBackground()
  scheduleMaintenance()
  await scheduleAutomationJobs()

  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
}, 60_000)

/** Белый список адресатов правил (N38, ADR-0141) — политикой безопасности. */
async function allowlist(ruleEmailDomains: string[], ruleWebhookDomains: string[]) {
  const response = await call(fx.app, {
    method: 'PATCH',
    url: '/admin/security-policy',
    as: fx.admin,
    payload: { ruleEmailDomains, ruleWebhookDomains },
  })
  expect(response.statusCode, response.body).toBe(200)
}

afterAll(async () => {
  await allowlist([], [])
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

describe('правила автоматизации: ведение', () => {
  it('правило не работает от имени сотрудника или администратора системы', async () => {
    for (const person of [fx.admin.id, fx.users.member.id]) {
      const response = await createRule({
        name: `Правило сотрудника ${run}`,
        runAs: person,
        trigger: { kind: 'event', type: 'object.created', filter: {} },
        actions: [{ type: 'add_tag', tag: 'тест' }],
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('служебной учётной записи')
    }
  })

  it('определение проверяется: неизвестное событие и чужой корень выражения', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/validate',
      as: fx.admin,
      payload: {
        definition: {
          name: { ru: 'Проверка' },
          runAs: bot.id,
          enabled: false,
          trigger: { kind: 'event', type: 'object.created', filter: {} },
          conditions: { expr: 'secret.value > 0' },
          actions: [{ type: 'add_tag', tag: 'т' }],
        },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().ok).toBe(false)
    expect(response.json().issues[0].path).toBe('conditions.0')
  })

  it('создаётся объектом реестра, включается и выключается', async () => {
    const created = await createRule({
      name: `Правило списка ${run}`,
      runAs: bot.id,
      enabled: false,
      trigger: { kind: 'event', type: 'object.created', filter: {} },
      actions: [{ type: 'add_tag', tag: 'список' }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    const object = await call(fx.app, { url: `/objects/${id}`, as: fx.admin })
    expect(object.statusCode).toBe(200)
    expect(object.json().type).toBe('rule')

    const list = await call(fx.app, {
      url: `/automation/rules?spaceId=${fx.spaceId}`,
      as: fx.admin,
    })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().items.some((item: { id: string }) => item.id === id)).toBe(true)

    const enabled = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${id}/enabled`,
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(enabled.statusCode, enabled.body).toBe(200)
    expect(enabled.json().enabled).toBe(true)

    // Посторонний не видит правило и не может его трогать
    const foreign = await call(fx.app, { url: `/automation/rules/${id}`, as: fx.users.stranger })
    expect(foreign.statusCode).toBe(404)

    // Выключаем: правило без условий иначе срабатывает на каждый объект теста
    const off = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${id}/enabled`,
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(off.json().enabled).toBe(false)
  })
})

describe('правила автоматизации: исполнение', () => {
  it('срабатывает по событию, выполняет действие от имени run_as и пишет журнал', async () => {
    const created = await createRule({
      name: `Тег по созданию ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Автоправило')" },
      actions: [{ type: 'add_tag', tag: `авто-${run}` }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string

    const folderId = await createFolder(`Автоправило ${run}`)
    const runRecord = await waitForRun(ruleId, ['succeeded'])
    expect(runRecord.steps).toHaveLength(1)
    expect(runRecord.steps[0]?.status).toBe('ok')
    expect(runRecord.runAs?.id).toBe(bot.id)
    expect(runRecord.objectId).toBe(folderId)

    expect(await tagsOf(folderId)).toContain(`авто-${run}`)
  })

  it('событие о человеке: правило работает, хотя объект не в реестре', async () => {
    // `user.created` приносит объект вне реестра: запись прогона падала на
    // внешнем ключе, а проверка видимости отбрасывала запуск — правила
    // адаптации не работали вовсе
    const created = await createRule({
      name: `Адаптация ${run}`,
      runAs: bot.id,
      // Служебные учётные записи создаются тем же событием — адаптация им не нужна
      trigger: { kind: 'event', type: 'user.created', filter: { 'payload.kind': 'person' } },
      actions: [
        {
          type: 'notify',
          to: ['user:{{object.id}}'],
          text: 'Добро пожаловать',
          object: fx.spaceId,
        },
      ],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string

    const newcomer = await createUser(fx.app, `newbie_${run}`, ['employee'])
    const record = await waitForRun(ruleId, ['succeeded', 'failed', 'skipped'])
    expect(record.status, JSON.stringify(record.steps)).toBe('succeeded')
    expect(record.objectId).toBe(newcomer.id)
    expect(record.steps[0]?.status).toBe('ok')
  })

  it('условие не выполнено — запуск помечен пропущенным с причиной', async () => {
    const created = await createRule({
      name: `Условие мимо ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "object.title == 'такого названия нет'" },
      actions: [{ type: 'add_tag', tag: 'нет' }],
    })
    const ruleId = created.json().id as string
    await createFolder(`Мимо условия ${run}`)
    const runRecord = await waitForRun(ruleId, ['skipped'])
    expect(runRecord.error).toBe('Условие не выполнено')
  })

  it('ключ повтора занимает только запуск с выполненным условием', async () => {
    // Две ленты об одном толчке: первая запись не проходит условие — вторая должна
    // сработать, а третья с тем же ключом — пропуститься как повтор
    const created = await createRule({
      name: `Повтор после условия ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Годная')" },
      actions: [{ type: 'add_tag', tag: `повтор-${run}` }],
      limits: { maxRunsPerHour: 100, dedupeKey: `повтор-${run}`, dedupeWindowMinutes: 60 },
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string
    const finished = async (count: number) => {
      const started = Date.now()
      while (Date.now() - started < 25_000) {
        const items = (await runsOf(ruleId)).filter((item) => FINISHED.includes(item.status))
        if (items.length >= count) return items
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`не дождались ${count} запусков правила ${ruleId}`)
    }

    const miss = await createFolder(`Повтор мимо ${run}`)
    await finished(1)
    const first = await createFolder(`Повтор Годная первая ${run}`)
    await finished(2)
    const second = await createFolder(`Повтор Годная вторая ${run}`)
    const items = await finished(3)
    const byObject = new Map(items.map((item) => [item.objectId, item]))
    expect(byObject.get(miss)?.error).toBe('Условие не выполнено')
    expect(byObject.get(first)?.status).toBe('succeeded')
    expect(byObject.get(second)?.status).toBe('skipped')
    expect(byObject.get(second)?.error).toBe(`Повтор по ключу «повтор-${run}»`)
    expect(await tagsOf(first)).toContain(`повтор-${run}`)
    expect(await tagsOf(second)).not.toContain(`повтор-${run}`)

    await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/enabled`,
      as: fx.admin,
      payload: { enabled: false },
    })
  })

  it('служебный пользователь без доступа к объекту: правило не выполняется', async () => {
    const created = await createRule({
      name: `Чужое пространство ${run}`,
      runAs: outsider.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Закрытая')" },
      actions: [{ type: 'add_tag', tag: 'не должно быть' }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string

    const folderId = await createFolder(`Закрытая папка ${run}`)
    const runRecord = await waitForRun(ruleId, ['skipped', 'failed', 'succeeded'])
    expect(runRecord.status).toBe('skipped')
    expect(runRecord.error).toContain('не видит объект')

    expect(await tagsOf(folderId)).not.toContain('не должно быть')
  })

  it('заблокированная служебная запись: запуск не исполняется', async () => {
    // Решение принимается и в момент исполнения (ADR-0130): запись могли
    // заблокировать уже после включения правила
    const leaving = await serviceAccount(`Робот на выход ${run}`, [
      { spaceId: fx.spaceId, role: 'editor' },
    ])
    const created = await createRule({
      name: `Выход ${run}`,
      runAs: leaving.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Уход')" },
      actions: [{ type: 'add_tag', tag: `уход-${run}` }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string

    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/service-accounts/${leaving.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)

    const folderId = await createFolder(`Уход ${run}`)
    const runRecord = await waitForRun(ruleId, ['failed', 'succeeded', 'skipped'])
    expect(runRecord.status).toBe('failed')
    expect(runRecord.error).toContain('отключён')
    expect(await tagsOf(folderId)).not.toContain(`уход-${run}`)
  })

  it('уведомление не уходит тому, кто не видит объект', async () => {
    const created = await createRule({
      name: `Уведомление постороннему ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Уведомление')" },
      actions: [{ type: 'notify', to: [`user:${fx.users.stranger.id}`], text: 'Создана папка' }],
    })
    const ruleId = created.json().id as string
    await createFolder(`Уведомление ${run}`)
    const runRecord = await waitForRun(ruleId, ['succeeded'])
    expect(runRecord.steps[0]?.message).toBe('Получателей нет')

    const notifications = await call(fx.app, { url: '/notifications', as: fx.users.stranger })
    expect(notifications.statusCode).toBe(200)
    expect(notifications.body).not.toContain('Создана папка')
  })

  it('правило не запускается от собственных событий', async () => {
    const folderId = await createFolder(`Цикл ${run}`)
    const created = await createRule({
      name: `Цикл по тегам ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.tagged', filter: {} },
      conditions: { expr: `object.id == '${folderId}'` },
      actions: [{ type: 'add_tag', tag: `эхо-${run}` }],
    })
    const ruleId = created.json().id as string

    const tagged = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/tags`,
      as: fx.admin,
      payload: { name: `старт-${run}` },
    })
    expect(tagged.statusCode, tagged.body).toBe(200)

    await waitForRun(ruleId, ['succeeded'])
    // Событие `object.tagged` от самого правила не даёт второго запуска
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const items = await runsOf(ruleId)
    expect(items.filter((item) => item.status === 'succeeded')).toHaveLength(1)
  })

  it('повторная постановка по тому же событию ничего не дублирует', async () => {
    const created = await createRule({
      name: `Идемпотентность ${run}`,
      runAs: bot.id,
      enabled: false,
      trigger: { kind: 'event', type: 'object.created', filter: {} },
      actions: [{ type: 'add_tag', tag: 'и' }],
    })
    const ruleId = created.json().id as string
    const input = {
      ruleId,
      triggerKind: 'event' as const,
      eventId: `evt-${run}`,
      runAs: bot.id,
      context: {},
    }
    const first = await db().transaction((tx) => RuleRuns.queue(tx, systemCtx('test'), input))
    const second = await db().transaction((tx) => RuleRuns.queue(tx, systemCtx('test'), input))
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('лимит запусков в час: лишнее срабатывание пропускается с причиной', async () => {
    const created = await createRule({
      name: `Лимит ${run}`,
      runAs: bot.id,
      trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
      conditions: { expr: "contains(object.title, 'Лимитная')" },
      actions: [{ type: 'add_tag', tag: `лимит-${run}` }],
      limits: { maxRunsPerHour: 1, dedupeKey: null, dedupeWindowMinutes: 60 },
    })
    const ruleId = created.json().id as string
    await createFolder(`Лимитная 1 ${run}`)
    await waitForRun(ruleId, ['succeeded'])
    await createFolder(`Лимитная 2 ${run}`)
    const skipped = await waitForRun(ruleId, ['skipped'])
    expect(skipped.error).toContain('лимит')
  })
})

describe('правила автоматизации: ручной запуск и тестовый прогон', () => {
  it('кнопка у объекта: правило видно в меню и запускается', async () => {
    const created = await createRule({
      name: `Ручное правило ${run}`,
      runAs: bot.id,
      trigger: { kind: 'manual', objectTypes: ['folder'], confirm: false },
      actions: [{ type: 'add_tag', tag: `ручной-${run}` }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string
    const folderId = await createFolder(`Ручной запуск ${run}`)

    const menu = await call(fx.app, {
      url: `/automation/manual-rules?objectId=${folderId}`,
      as: fx.users.member,
    })
    expect(menu.statusCode, menu.body).toBe(200)
    expect(menu.json().items.some((item: { id: string }) => item.id === ruleId)).toBe(true)

    const started = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/run`,
      as: fx.users.member,
      payload: { objectId: folderId },
    })
    expect(started.statusCode, started.body).toBe(200)
    await waitForRun(ruleId, ['succeeded'])
    expect(await tagsOf(folderId)).toContain(`ручной-${run}`)

    // Посторонний не запускает правило на объекте, которого не видит
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/run`,
      as: fx.users.stranger,
      payload: { objectId: folderId },
    })
    expect([403, 404]).toContain(foreign.statusCode)
  })

  it('тестовый прогон показывает, что бы произошло, и ничего не делает', async () => {
    const folderId = await createFolder(`Прогон ${run}`)
    const response = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/dry-run',
      as: fx.admin,
      payload: {
        limit: 20,
        definition: {
          name: { ru: `Прогон ${run}` },
          runAs: bot.id,
          enabled: false,
          trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
          conditions: { expr: "contains(object.title, 'Прогон')" },
          actions: [{ type: 'add_tag', tag: 'прогон' }],
        },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json()
    expect(result.checked).toBeGreaterThan(0)
    const matched = result.items.filter((item: { matched: boolean }) => item.matched)
    expect(matched.length).toBeGreaterThan(0)
    expect(matched[0].actions[0].summary).toContain('прогон')

    // Действие не выполнено: тега на объекте нет
    expect(await tagsOf(folderId)).not.toContain('прогон')
  })
})

describe('белый список адресатов правил (N38)', () => {
  it('письмо на чужой домен и вебхук мимо списка не сохраняются; поддомен разрешённого — можно', async () => {
    await allowlist([], [])
    const check = async (actions: Array<Record<string, unknown>>) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/automation/rules/validate',
        as: fx.admin,
        payload: {
          definition: {
            name: { ru: 'Адресаты' },
            runAs: bot.id,
            enabled: true,
            trigger: { kind: 'event', type: 'object.created', filter: {} },
            conditions: { expr: "object.type = 'folder'" },
            actions,
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return response.json() as { ok: boolean; issues: Array<{ path: string; message: string }> }
    }
    const actions = [
      {
        type: 'send_email',
        to: ['duty@partner.tj', `user:${fx.users.member.id}`],
        subject: 'Т',
        body: 'Т',
      },
      { type: 'webhook', url: 'https://hooks.partner.tj/in' },
    ]
    const denied = await check(actions)
    expect(denied.ok).toBe(false)
    expect(denied.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['actions.0.to.0', 'actions.1.url']),
    )
    expect(denied.issues.find((issue) => issue.path === 'actions.0.to.0')?.message).toContain(
      'нет в белом списке',
    )
    // Сотрудник из справочника — адрес организации, его список не касается
    expect(denied.issues.some((issue) => issue.path === 'actions.0.to.1')).toBe(false)

    await allowlist(['partner.tj'], ['partner.tj'])
    expect((await check(actions)).ok).toBe(true)
  })

  it('сузили список — правило не включается, а запуск отказывает с причиной', async () => {
    await allowlist([], ['partner.tj'])
    const created = await createRule({
      name: `Вебхук партнёру ${run}`,
      runAs: bot.id,
      trigger: { kind: 'manual', objectTypes: ['folder'], confirm: false },
      actions: [{ type: 'webhook', url: 'https://hooks.partner.tj/in' }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string
    const folderId = await createFolder(`Вызов партнёру ${run}`)

    await allowlist([], [])
    const started = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/run`,
      as: fx.admin,
      payload: { objectId: folderId },
    })
    expect(started.statusCode, started.body).toBe(200)
    const failed = await waitForRun(ruleId, ['failed', 'succeeded'])
    expect(failed.status).toBe('failed')
    expect(JSON.stringify(failed)).toContain('нет в списке разрешённых')

    const off = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/enabled`,
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(off.statusCode, off.body).toBe(200)
    const on = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/enabled`,
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(on.statusCode).toBe(400)
    expect(on.body).toContain('Правило не включено')
  })
})

describe('расписания', () => {
  it('экран показывает проверки платформы и правила по cron', async () => {
    // Вебхук правила — только на разрешённый домен (N38)
    await allowlist([], ['example.invalid'])
    const created = await createRule({
      name: `По расписанию ${run}`,
      runAs: bot.id,
      trigger: { kind: 'schedule', cron: '0 6 * * *', timezone: 'Asia/Dushanbe', objectId: null },
      actions: [{ type: 'webhook', url: 'https://example.invalid/hook' }],
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string

    const list = await call(fx.app, { url: '/schedules', as: fx.admin })
    expect(list.statusCode, list.body).toBe(200)
    const items = list.json().items as Array<{
      key: string
      kind: string
      nextRunAt: string | null
    }>
    expect(items.some((item) => item.key === 'maintenance:trash.purge')).toBe(true)
    const ruleSchedule = items.find((item) => item.key === `rule:${ruleId}`)
    expect(ruleSchedule?.kind).toBe('rule')
    expect(ruleSchedule?.nextRunAt).not.toBeNull()

    const off = await call(fx.app, {
      method: 'POST',
      url: '/schedules/maintenance:trash.purge/enabled',
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(off.statusCode, off.body).toBe(200)
    expect(off.json().enabled).toBe(false)
    expect(off.json().nextRunAt).toBeNull()

    const on = await call(fx.app, {
      method: 'POST',
      url: '/schedules/maintenance:trash.purge/enabled',
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(on.json().enabled).toBe(true)
  })

  it('без способности управления автоматизацией экран недоступен', async () => {
    const response = await call(fx.app, { url: '/schedules', as: fx.users.member })
    expect(response.statusCode).toBe(403)
  })
})
