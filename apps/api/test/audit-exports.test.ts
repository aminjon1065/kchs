import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Аудит выгрузок и изменений, которые раньше в журнал не попадали (ADR-0185,
 * 17-security.md §6): выгрузка контроля исполнения, файл правила автоматизации,
 * изменения подразделений, окончательное удаление объекта. Смена секрета
 * вебхука — изменение с событием и аудитом в одной транзакции.
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

async function auditRows(action: string, objectId?: string): Promise<Array<{ details: unknown }>> {
  const rows = await db().execute<{ details: unknown }>(
    objectId
      ? sql`SELECT details FROM audit_log WHERE action = ${action} AND object_id = ${objectId}`
      : sql`SELECT details FROM audit_log WHERE action = ${action}
             AND occurred_at > now() - interval '5 minutes'`,
  )
  return [...rows]
}

beforeAll(async () => {
  fx = await setupFixture()
})

describe('выгрузки в аудите', () => {
  it('выгрузка контроля исполнения пишется в журнал', async () => {
    const before = (await auditRows('tasks.control_exported')).length
    const csv = await call(fx.app, { url: '/tasks/control/export?format=csv', as: fx.admin })
    expect(csv.statusCode, csv.body).toBe(200)
    const list = await call(fx.app, {
      url: '/tasks/control/export?format=csv&view=list&bucket=overdue',
      as: fx.admin,
    })
    expect(list.statusCode, list.body).toBe(200)
    const rows = await auditRows('tasks.control_exported')
    expect(rows.length - before).toBe(2)
  })

  it('файл правила автоматизации пишется в журнал', async () => {
    const bot = await call(fx.app, {
      method: 'POST',
      url: '/service-accounts',
      as: fx.admin,
      payload: {
        name: `Робот выгрузки ${run}`,
        roleKeys: ['employee'],
        spaces: [{ spaceId: fx.spaceId, role: 'editor' }],
      },
    })
    expect(bot.statusCode, bot.body).toBe(200)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules',
      as: fx.admin,
      payload: {
        spaceId: fx.spaceId,
        definition: {
          name: { ru: `Правило выгрузки ${run}` },
          runAs: bot.json().id as string,
          enabled: false,
          trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
          conditions: null,
          actions: [{ type: 'add_tag', tag: `тег-${run}` }],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const ruleId = created.json().id as string
    const exported = await call(fx.app, { url: `/automation/rules/${ruleId}/export`, as: fx.admin })
    expect(exported.statusCode, exported.body).toBe(200)
    expect(await auditRows('automation.rule_exported', ruleId)).toHaveLength(1)
  })
})

describe('изменения в аудите', () => {
  it('создание и правка подразделения — в журнале вместе с событием', async () => {
    const unit = await call(fx.app, {
      method: 'POST',
      url: '/org/units',
      as: fx.admin,
      payload: { code: `AUD-${run}`, name: { ru: 'Отдел аудита' }, kind: 'department' },
    })
    expect(unit.statusCode, unit.body).toBe(200)
    const unitId = unit.json().id as string
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${unitId}`,
      as: fx.admin,
      payload: { name: { ru: 'Отдел аудита и контроля' } },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const rows = await auditRows('org.changed', unitId)
    expect(rows.map((row) => (row.details as { change: string }).change).sort()).toEqual([
      'created',
      'updated',
    ])
  })

  it('окончательное удаление объекта — в журнале', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка на удаление ${run}`, spaceId: fx.spaceId },
    })
    expect(folder.statusCode, folder.body).toBe(200)
    const folderId = folder.json().id as string
    await db().transaction((tx) => ObjectService.purge(tx, systemCtx('test.purge'), folderId))
    const rows = await auditRows('object.purged', folderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.details).toMatchObject({ title: `Папка на удаление ${run}` })
  })

  it('смена секрета вебхука — событие и аудит вместе с записью', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/webhooks',
      as: fx.admin,
      payload: { name: `Вебхук ${run}`, url: 'http://127.0.0.1:9/hook', eventTypes: ['object.*'] },
    })
    expect(created.statusCode, created.body).toBe(200)
    const webhookId = created.json().webhook.id as string
    const rotated = await call(fx.app, {
      method: 'POST',
      url: `/webhooks/${webhookId}/secret`,
      as: fx.admin,
    })
    expect(rotated.statusCode, rotated.body).toBe(200)
    const events = await db().execute<{ changed: string[] }>(
      sql`SELECT event->'payload'->'changed' AS changed FROM ops.outbox
           WHERE type = 'webhook.updated' AND event->'object'->>'id' = ${webhookId}`,
    )
    expect([...events].map((event) => event.changed)).toContainEqual(['secret'])
    expect(await auditRows('webhook.secret_rotated', webhookId)).toHaveLength(1)
  })
})
