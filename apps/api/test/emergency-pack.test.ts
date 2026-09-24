import { RuleDefinition } from '@kchs/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootTestApp, db, registerLifecycle, resetTestData } from './helpers.js'

/**
 * Предметный пакет «Чрезвычайные ситуации» (P5-E08, ADR-0128) на чистой установке:
 * `kchs init`, затем `kchs seed --profile minimal --pack emergency`. Пакет сам заводит
 * «Общее», ставит реестры, карту, дашборды, формы, ленты, алерты и правила без
 * синтетики демо-мира, а повторный запуск ничего не дублирует. Условия правил лент
 * проверяются на образцах событий: давние и слабые толчки смену не поднимают.
 */
registerLifecycle()

const { runInit } = await import('../src/cli/init.js')
const { seedCommand } = await import('../src/seed/command.js')
const { datasets, forms, objects, rules, sources, spaces, users } = await import(
  '../src/shared/db/schema/index.js'
)
const { evaluateRuleCondition, ruleScope } = await import(
  '../src/modules/automation/domain/scope.js'
)

const PACK_KEY = sql<string>`coalesce(${objects.meta}->>'packKey', ${objects.meta}->>'systemKey')`

/** Объекты пакета по ключу: удалённые не считаются. */
async function packObjects(): Promise<Map<string, string>> {
  const rows = await db()
    .select({ id: objects.id, key: PACK_KEY })
    .from(objects)
    .where(and(isNull(objects.deletedAt), sql`${PACK_KEY} like 'emergency.%'`))
  return new Map(rows.map((row) => [row.key, row.id]))
}

async function rowCount(datasetId: string): Promise<number> {
  const [dataset] = await db()
    .select({ table: datasets.physicalTable })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
  const [row] = await db().execute<{ total: number }>(
    sql`SELECT count(*)::int AS total FROM ${sql.identifier('ds')}.${sql.identifier(dataset?.table as string)} WHERE _deleted_at IS NULL`,
  )
  return Number(row?.total ?? -1)
}

beforeAll(async () => {
  await bootTestApp()
  await resetTestData()
  await runInit({ adminLogin: 'admin', adminEmail: 'admin@example.tj' })
}, 120_000)

describe('пакет ЧС: чистая установка', () => {
  it('ставится без демо-мира: «Общее», реестры, автоматизация и ни одной синтетической строки', async () => {
    const seeded = await seedCommand({ profile: 'minimal', reset: false, pack: 'emergency' })
    expect(seeded.pack).toMatchObject({ datasets: 11, dashboards: 5, pages: 6 })

    const [org] = await db().select({ kind: spaces.kind }).from(spaces).where(eq(spaces.key, 'org'))
    expect(org?.kind).toBe('org')

    const found = await packObjects()
    for (const key of [
      'emergency.dataset.incidents',
      'emergency.dataset.hazard_messages',
      'emergency.map.situation',
      'emergency.dashboard.situation',
      'emergency.metric.hq_tasks_overdue',
      'emergency.form.daily_summary',
      'emergency.feed.usgs',
      'emergency.feed.gdacs',
      'emergency.alert.water',
      'emergency.page.hazard-feeds',
    ]) {
      expect(found.has(key), key).toBe(true)
    }

    // Синтетика демо-мира — только в профиле demo
    for (const key of ['shelters', 'forces', 'warnings_log', 'duty_roster']) {
      expect(await rowCount(found.get(`emergency.dataset.${key}`) as string), key).toBe(0)
    }

    // Служебная учётная запись — владелец лент; ленты включены и по расписанию
    const [writer] = await db()
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(and(eq(users.kind, 'service'), eq(users.displayName, 'Автоматизация штаба ЧС')))
    expect(writer?.status).toBe('active')
    const feeds = await db()
      .select({ enabled: sources.enabled, schedule: sources.schedule, owner: objects.ownerId })
      .from(sources)
      .innerJoin(objects, eq(objects.id, sources.id))
      .where(sql`${PACK_KEY} like 'emergency.feed.%'`)
    expect(feeds).toHaveLength(5)
    for (const feed of feeds) {
      expect(feed).toMatchObject({ enabled: true, owner: writer?.id })
      expect(feed.schedule).toBeTruthy()
    }

    // Без назначений формы выключены: их включает администратор, назначив управления
    const packForms = await db()
      .select({ enabled: forms.enabled })
      .from(forms)
      .innerJoin(objects, eq(objects.id, forms.id))
      .where(sql`${PACK_KEY} like 'emergency.form.%'`)
    expect(packForms).toEqual([{ enabled: false }, { enabled: false }])

    // Правила: руководители — выражениями по кодам подразделений; приём смены ждёт их назначения
    const installed = await db()
      .select({ key: rules.key, enabled: rules.enabled, definition: rules.definition })
      .from(rules)
      .where(sql`${rules.key} like 'emergency-%'`)
    const byKey = new Map(installed.map((rule) => [rule.key, rule]))
    expect([...byKey.keys()].sort()).toEqual([
      'emergency-duty-handover',
      'emergency-hazard-duty',
      'emergency-incident-deaths',
      'emergency-report-hq',
      'emergency-strong-quake-hq',
      'emergency-water-alert',
    ])
    expect(byKey.get('emergency-duty-handover')?.enabled).toBe(false)
    expect(byKey.get('emergency-hazard-duty')?.enabled).toBe(true)
    const report = RuleDefinition.parse(byKey.get('emergency-report-hq')?.definition)
    expect(report.actions.find((action) => action.type === 'create_task')).toMatchObject({
      assignee: "unit_head('UO')",
      controller: "unit_head('HQ')",
    })
  })

  it('повторный запуск ничего не дублирует', async () => {
    const before = await packObjects()
    const again = await seedCommand({ profile: 'minimal', reset: false, pack: 'emergency' })
    expect(again.pack).toMatchObject({ datasets: 11, dashboards: 5, pages: 0 })
    const after = await packObjects()
    expect(after).toEqual(before)
    const [counted] = await db()
      .select({ total: sql<number>`count(*)::int` })
      .from(rules)
      .where(sql`${rules.key} like 'emergency-%'`)
    expect(counted?.total).toBe(6)
  })
})

describe('пакет ЧС: условия правил лент', () => {
  const now = '2026-09-24T12:00:00.000Z'

  async function conditionOf(key: string) {
    const [rule] = await db()
      .select({ definition: rules.definition })
      .from(rules)
      .where(eq(rules.key, key))
    const definition = RuleDefinition.parse(rule?.definition)
    if (!definition.conditions) throw new Error(`у правила ${key} нет условия`)
    return definition.conditions
  }

  /** Событие строки сообщения: значения и путь района кодами (ADR-0133). */
  function holds(
    condition: Awaited<ReturnType<typeof conditionOf>>,
    values: Record<string, unknown>,
    path: string[] | null,
  ): boolean {
    const payload = {
      rowId: '1',
      values,
      labels: {},
      territories: path ? { territory: { id: 'x', code: path.at(-1), name: 'Район', path } } : {},
    }
    const scope = ruleScope(
      {
        event: {
          id: 'e',
          type: 'dataset.row_created',
          occurredAt: now,
          payload,
          changedFields: null,
          correlationId: null,
        },
        object: null,
        actor: { id: null, kind: 'system', displayName: null },
        previous: {},
        now,
      },
      'Asia/Dushanbe',
    )
    return evaluateRuleCondition(condition, scope)
  }

  const inGbao = ['TJ', 'TJ-GB', 'TJ-GB-04']

  it('дежурной смене — свежий толчок от M4 и свежий паводок в стране', async () => {
    const duty = await conditionOf('emergency-hazard-duty')
    const quake = (magnitude: number, occurred: string) => ({
      hazard: 'earthquake',
      magnitude,
      occurred_at: occurred,
    })
    expect(holds(duty, quake(4.5, '2026-09-24T10:30:00Z'), inGbao)).toBe(true)
    // Слабый, давний (первая загрузка ленты) и за границей — без уведомления
    expect(holds(duty, quake(3.8, '2026-09-24T10:30:00Z'), inGbao)).toBe(false)
    expect(holds(duty, quake(5.1, '2026-06-03T06:58:57Z'), inGbao)).toBe(false)
    expect(holds(duty, quake(4.9, '2026-09-24T10:30:00Z'), null)).toBe(false)
    // Паводок и тревога GDACS — в пределах недели от начала события
    const flood = { hazard: 'flood', occurred_at: '2026-09-20T00:00:00Z' }
    expect(holds(duty, flood, inGbao)).toBe(true)
    expect(holds(duty, { ...flood, occurred_at: '2026-09-10T00:00:00Z' }, inGbao)).toBe(false)
    const drought = {
      hazard: 'drought',
      alert_level: 'orange',
      occurred_at: '2026-09-22T00:00:00Z',
    }
    expect(holds(duty, drought, inGbao)).toBe(true)
    expect(holds(duty, { ...drought, alert_level: 'green' }, inGbao)).toBe(false)
  })

  it('руководству штаба — сильный толчок во всей области мониторинга, но не давний', async () => {
    const hq = await conditionOf('emergency-strong-quake-hq')
    const quake = { hazard: 'earthquake', magnitude: 5.8, occurred_at: '2026-09-24T09:00:00Z' }
    expect(holds(hq, quake, null)).toBe(true)
    expect(holds(hq, { ...quake, magnitude: 5.2 }, null)).toBe(false)
    expect(holds(hq, { ...quake, occurred_at: '2026-06-27T13:34:52Z' }, null)).toBe(false)
  })
})
