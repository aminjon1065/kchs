import type { RuleRunRecord } from '@kchs/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Правила автоматизации, волна «закончить разработку» (ADR-0163): ветка «иначе», версии с
 * откатом, копия, файл одного правила без секретов, действия «Запустить пайплайн» и
 * «Запустить импорт», тестовый прогон расписания и кнопки у объекта.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { startWorkers, stopWorkers } = await import('../src/kernel/jobs/runner.js')
const { registerAutomationBackground, scheduleAutomationJobs } = await import(
  '../src/modules/automation/module.js'
)

let fx: TestContext
let previousSubscribers: Subscriber[] = []
const run = Date.now().toString(36)
let bot: { id: string }

async function serviceAccount(name: string): Promise<{ id: string }> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/service-accounts',
    as: fx.admin,
    payload: { name, roleKeys: ['employee'], spaces: [{ spaceId: fx.spaceId, role: 'editor' }] },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { id: string }
}

function definition(input: Record<string, unknown>) {
  return {
    name: { ru: `Правило ${run}` },
    runAs: bot.id,
    enabled: false,
    trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
    conditions: null,
    actions: [{ type: 'add_tag', tag: `тег-${run}` }],
    ...input,
  }
}

async function createRule(input: Record<string, unknown>): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/automation/rules',
    as: fx.admin,
    payload: { spaceId: fx.spaceId, definition: definition(input) },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

async function createFolder(name: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

async function waitForRun(ruleId: string, statuses: string[]): Promise<RuleRunRecord> {
  const started = Date.now()
  while (Date.now() - started < 25_000) {
    const response = await call(fx.app, { url: `/automation/rules/${ruleId}/runs`, as: fx.admin })
    const found = (response.json().items as RuleRunRecord[]).find((item) =>
      statuses.includes(item.status),
    )
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`запуск правила ${ruleId} (${statuses.join('|')}) не дождался`)
}

async function tagsOf(objectId: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/objects/${objectId}`, as: fx.admin })
  return (response.json().tags as Array<{ name: string }>).map((tag) => tag.name)
}

beforeAll(async () => {
  fx = await setupFixture()
  bot = await serviceAccount(`Робот версий ${run}`)
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  registerAutomationBackground()
  await scheduleAutomationJobs()
  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
}, 60_000)

afterAll(async () => {
  await call(fx.app, {
    method: 'PATCH',
    url: '/admin/security-policy',
    as: fx.admin,
    payload: { ruleWebhookDomains: [] },
  })
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

describe('правила: версии, копия, файл правила', () => {
  it('каждая правка определения — версия; включение версией не считается; откат — новая версия', async () => {
    const ruleId = await createRule({})
    const record = (await call(fx.app, { url: `/automation/rules/${ruleId}`, as: fx.admin })).json()
    const edited = await call(fx.app, {
      method: 'PUT',
      url: `/automation/rules/${ruleId}`,
      as: fx.admin,
      payload: {
        definition: { ...record.definition, actions: [{ type: 'add_tag', tag: `новый-${run}` }] },
      },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    const enabled = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/enabled`,
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(enabled.statusCode, enabled.body).toBe(200)

    const versions = (
      await call(fx.app, { url: `/automation/rules/${ruleId}/versions`, as: fx.admin })
    ).json().items as Array<{ id: string; number: number; reason: string; changed: string[] }>
    expect(versions.map((item) => [item.number, item.reason])).toEqual([
      [2, 'update'],
      [1, 'create'],
    ])
    expect(versions[0]?.changed).toEqual(['actions'])

    const restored = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/versions/${versions[1]?.id}/restore`,
      as: fx.admin,
    })
    expect(restored.statusCode, restored.body).toBe(200)
    // Определение — первой версии, а «включено» — текущее
    expect(restored.json().definition.actions[0].tag).toBe(`тег-${run}`)
    expect(restored.json().enabled).toBe(true)
    const after = (
      await call(fx.app, { url: `/automation/rules/${ruleId}/versions`, as: fx.admin })
    ).json().items
    expect(after[0]).toMatchObject({ number: 3, reason: 'restore' })

    // Чужая версия не подставляется
    const other = await createRule({})
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${other}/versions/${versions[1]?.id}/restore`,
      as: fx.admin,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('копия — выключенная, с пометкой в названии и своей историей', async () => {
    const ruleId = await createRule({ name: { ru: `Оригинал ${run}`, en: `Original ${run}` } })
    const copied = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/duplicate`,
      as: fx.admin,
    })
    expect(copied.statusCode, copied.body).toBe(200)
    const copy = (
      await call(fx.app, { url: `/automation/rules/${copied.json().id}`, as: fx.admin })
    ).json()
    expect(copy.name).toEqual({ ru: `Оригинал ${run} (копия)`, en: `Original ${run} (copy)` })
    expect(copy.enabled).toBe(false)
    const versions = (
      await call(fx.app, { url: `/automation/rules/${copy.id}/versions`, as: fx.admin })
    ).json().items
    expect(versions[0]).toMatchObject({ number: 1, reason: 'duplicate' })
  })

  it('файл правила — без секретов и служебного пользователя; импорт — выключенным', async () => {
    // Вебхук — только на разрешённые домены (ADR-0141)
    const policy = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/security-policy',
      as: fx.admin,
      payload: { ruleWebhookDomains: ['example.org'] },
    })
    expect(policy.statusCode, policy.body).toBe(200)
    const ruleId = await createRule({
      actions: [
        {
          type: 'webhook',
          url: 'https://erp.example.org/hook',
          headers: { Authorization: 'Bearer секрет', 'X-Source': 'kchs' },
          payload: {},
          secret: 'подпись',
        },
      ],
    })
    const exported = await call(fx.app, {
      url: `/automation/rules/${ruleId}/export`,
      as: fx.admin,
    })
    expect(exported.statusCode, exported.body).toBe(200)
    const file = exported.json()
    expect(file).toMatchObject({ format: 'kchs.rule', version: 1 })
    expect(file.definition.runAs).toBeNull()
    expect(file.definition.enabled).toBe(false)
    expect(file.definition.actions[0]).toMatchObject({
      secret: null,
      headers: { Authorization: '', 'X-Source': 'kchs' },
    })
    expect(exported.body).not.toContain('секрет')

    for (const _ of [1, 2]) {
      const imported = await call(fx.app, {
        method: 'POST',
        url: '/automation/rules/import',
        as: fx.admin,
        payload: { spaceId: fx.spaceId, rule: file },
      })
      expect(imported.statusCode, imported.body).toBe(200)
      const rule = (
        await call(fx.app, { url: `/automation/rules/${imported.json().id}`, as: fx.admin })
      ).json()
      expect(rule.enabled).toBe(false)
      expect(rule.runAs).toBeNull()
      // Ключ правила уникален: исходное правило с этим ключом есть — у импорта свой
      expect(rule.key).not.toBe(file.key)
    }

    const broken = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/import',
      as: fx.admin,
      payload: { spaceId: fx.spaceId, rule: { ...file, format: 'чужой' } },
    })
    expect(broken.statusCode).toBe(400)
  })
})

describe('правила: ветка «иначе» и новые действия', () => {
  it('условие не выполнено — выполняется ветка «иначе» с отметкой в шагах', async () => {
    const ruleId = await createRule({
      enabled: true,
      conditions: { expr: "contains(object.title, 'Важное')" },
      actions: [{ type: 'add_tag', tag: `важное-${run}` }],
      otherwise: [{ type: 'add_tag', tag: `обычное-${run}` }],
    })
    const folderId = await createFolder(`Обычная папка ${run}`)
    const record = await waitForRun(ruleId, ['succeeded', 'failed'])
    expect(record.status, JSON.stringify(record.steps)).toBe('succeeded')
    expect(record.steps[0]).toMatchObject({ status: 'ok', branch: 'otherwise' })
    const tags = await tagsOf(folderId)
    expect(tags).toContain(`обычное-${run}`)
    expect(tags).not.toContain(`важное-${run}`)
  })

  it('«Запустить пайплайн» и «Запустить импорт»: нужен идентификатор или шаблон, права — у run_as', async () => {
    const invalid = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/validate',
      as: fx.admin,
      payload: {
        definition: definition({
          actions: [
            { type: 'run_pipeline', pipelineId: 'не-идентификатор' },
            { type: 'run_import', sourceId: '{{event.payload.sourceId}}' },
          ],
        }),
      },
    })
    expect(invalid.statusCode, invalid.body).toBe(200)
    const issues = invalid.json().issues as Array<{ path: string; severity: string }>
    expect(issues.filter((issue) => issue.severity === 'error').map((i) => i.path)).toEqual([
      'actions.0.pipelineId',
    ])

    // Пайплайна с таким идентификатором нет: запуск падает на проверке прав, а не молча
    const ruleId = await createRule({
      enabled: true,
      trigger: { kind: 'manual', objectTypes: ['folder'], confirm: false },
      actions: [{ type: 'run_pipeline', pipelineId: '00000000-0000-4000-8000-000000000000' }],
    })
    const folderId = await createFolder(`Пайплайн ${run}`)
    const started = await call(fx.app, {
      method: 'POST',
      url: `/automation/rules/${ruleId}/run`,
      as: fx.admin,
      payload: { objectId: folderId },
    })
    expect(started.statusCode, started.body).toBe(200)
    const record = await waitForRun(ruleId, ['failed', 'succeeded'])
    expect(record.status).toBe('failed')
    expect(record.steps[0]).toMatchObject({ action: 'run_pipeline', status: 'failed' })
  })

  it('тестовый прогон: расписание — один запуск «сейчас», кнопка — последние объекты', async () => {
    const folderId = await createFolder(`Прогон кнопки ${run}`)
    const schedule = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/dry-run',
      as: fx.admin,
      payload: {
        limit: 5,
        definition: definition({
          trigger: { kind: 'schedule', cron: '0 8 * * 1', timezone: 'Asia/Dushanbe' },
          conditions: { expr: 'false' },
          otherwise: [{ type: 'add_tag', tag: 'иначе' }],
        }),
      },
    })
    expect(schedule.statusCode, schedule.body).toBe(200)
    expect(schedule.json().items).toHaveLength(1)
    expect(schedule.json().items[0]).toMatchObject({ matched: true, branch: 'otherwise' })

    const manual = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/dry-run',
      as: fx.admin,
      payload: {
        limit: 5,
        definition: definition({
          trigger: { kind: 'manual', objectTypes: ['folder'], confirm: false },
        }),
      },
    })
    expect(manual.statusCode, manual.body).toBe(200)
    const items = manual.json().items as Array<{ objectId: string; matched: boolean }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.map((item) => item.objectId)).toContain(folderId)
    expect(items.every((item) => item.matched)).toBe(true)
    // Действие не выполнено
    expect(await tagsOf(folderId)).not.toContain(`тег-${run}`)
  })
})
