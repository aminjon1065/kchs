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
} from './helpers.js'

/**
 * Документооборот демо-мира в работе (P3-E05 S02): поверх демо-документов сид
 * запускает маршруты (исходящие на согласовании и подписи, записки на подписи
 * руководителя подразделения) и накладывает резолюции по направлениям — от
 * имени участников, как в интерфейсе. Повторный запуск ничего не добавляет.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { OrgService } = await import('../src/modules/identity/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const run = Date.now().toString(36)
let fx: TestContext
let registrar: TestUser
let chief: TestUser
let head: TestUser
const staff: TestUser[] = []

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

async function inbox(user: TestUser): Promise<Json[]> {
  const response = await call(fx.app, { url: '/inbox?state=open', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items as Json[]
}

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  // Управление (руководитель — заместитель по маршруту) → отдел исполнителей
  const directorate = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `DIR-${run}`,
      name: { ru: 'Управление мониторинга' },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  const division = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `DIV-${run}`,
      name: { ru: 'Отдел прогнозов' },
      kind: 'division',
      parentId: directorate,
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  registrar = await createUser(fx.app, `demo_reg_${run}`, ['employee', 'registrar'], directorate)
  chief = await createUser(fx.app, `demo_chief_${run}`, ['employee'], directorate)
  head = await createUser(fx.app, `demo_head_${run}`, ['employee'], division)
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    staff.push(await createUser(fx.app, `demo_staff_${index}_${run}`, ['employee'], division))
  }
  await db().transaction(async (tx) => {
    await OrgService.updateUnit(tx, ctx, directorate, { headUserId: chief.id })
    await OrgService.updateUnit(tx, ctx, division, { headUserId: head.id })
  })
  await DocumentsSeed.ensureStarterSet(ctx, { demo: true })
  const people = {
    registrars: [{ id: registrar.id, unitId: directorate }],
    heads: [
      { id: head.id, unitId: division },
      { id: chief.id, unitId: directorate },
    ],
    staff: staff.map((user) => ({ id: user.id, unitId: division })),
    officeUnitId: directorate,
  }
  const seeded = await DocumentsSeed.seedDemoDocuments(people)
  expect(seeded.skipped).toBe(false)
  const workflow = await DocumentsSeed.seedDemoWorkflow(people)
  expect(workflow).toMatchObject({ skipped: false, routes: 6, resolutions: 6 })
  expect(await DocumentsSeed.seedDemoWorkflow(people)).toEqual({
    routes: 0,
    resolutions: 0,
    skipped: true,
  })
}, 240_000)

describe('документооборот демо-мира в работе', () => {
  it('исходящие на разных шагах маршрута, записки на подписи руководителя отдела', async () => {
    const flows = await db().execute<{ flow: string; status: string; type: string }>(
      sql`SELECT o.meta->>'demoFlow' AS flow, d.status, t.key AS type
            FROM documents d JOIN objects o ON o.id = d.id
            JOIN document_types t ON t.id = d.type_id
           WHERE o.meta ? 'demoFlow' AND o.meta->>'demoFlow' LIKE 'route:%'`,
    )
    const outgoing = new Map(
      flows.filter((row) => row.type === 'outgoing_letter').map((row) => [row.flow, row.status]),
    )
    expect(Object.fromEntries(outgoing)).toEqual({
      'route:started': 'on_approval',
      'route:one_approved': 'on_approval',
      'route:deputy': 'on_approval',
      'route:signing': 'on_signing',
    })
    expect(
      flows.filter((row) => row.type === 'memo').map((row) => `${row.flow}:${row.status}`),
    ).toEqual(['route:signing:on_signing', 'route:signing:on_signing'])

    // Заместитель — руководитель управления над руководителем отдела автора
    const chiefItems = await inbox(chief)
    expect(chiefItems.some((item) => item.kind === 'approve')).toBe(true)
    // Руководитель отдела подписывает записки из Входящих
    const headItems = await inbox(head)
    expect(headItems.filter((item) => item.kind === 'sign').length).toBeGreaterThanOrEqual(2)
  })

  it('резолюции по направлениям: поручения сотрудникам отдела, документы на исполнении', async () => {
    const resolved = await db().execute<{ status: string; responsible: string; total: number }>(
      sql`SELECT d.status, r.responsible_id AS responsible, count(*)::int AS total
            FROM resolutions r JOIN documents d ON d.id = r.document_id
            JOIN objects o ON o.id = d.id
           WHERE o.meta->>'demoFlow' = 'resolution'
           GROUP BY d.status, r.responsible_id`,
    )
    expect(resolved.reduce((sum, row) => sum + row.total, 0)).toBe(6)
    expect(resolved.every((row) => row.status === 'on_execution')).toBe(true)
    const team = new Set(staff.map((user) => user.id))
    expect(resolved.every((row) => team.has(row.responsible))).toBe(true)
    // Исполнители получили поручения во Входящих
    const assigned = await Promise.all(staff.map((user) => inbox(user)))
    expect(
      assigned.flat().filter((item) => item.kind === 'accept_instruction').length,
    ).toBeGreaterThanOrEqual(6)
  })
})
