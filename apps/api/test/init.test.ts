import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootTestApp, call, db, registerLifecycle, resetTestData } from './helpers.js'

/**
 * `kchs init` (02-roadmap.md, критерий готовности фазы 0): миграции, системные
 * роли, базовые справочники и первый администратор на чистой установке;
 * повторный запуск ничего не пересоздаёт, демо-данные ставятся поверх.
 */
registerLifecycle()

const { formatInitSummary, runInit } = await import('../src/cli/init.js')
const { seedCommand } = await import('../src/seed/command.js')
const { businessCalendar, users } = await import('../src/shared/db/schema/index.js')

const now = new Date('2026-09-18T10:00:00Z')
let app: FastifyInstance

beforeAll(async () => {
  app = await bootTestApp()
  await resetTestData()
})

describe('kchs init', () => {
  it('первый запуск: роли, календарь РТ, администратор с временным паролем', async () => {
    const summary = await runInit({ adminLogin: 'admin', adminEmail: 'admin@example.tj', now })
    expect(summary.roles).toBeGreaterThan(0)
    // 11 праздничных дней с постоянной датой: 1.01, 8.03, 21–24.03, 1.05, 9.05, 27.06, 9.09, 6.11
    expect(summary.calendar).toEqual([
      { year: 2026, added: 11 },
      { year: 2027, added: 11 },
    ])
    expect(summary.admin).toMatchObject({ login: 'admin', created: true })
    const password = summary.admin.temporaryPassword
    expect(password).toBeTruthy()
    expect(formatInitSummary(summary)).toContain(password as string)

    const navruz = await db()
      .select({ kind: businessCalendar.kind })
      .from(businessCalendar)
      .where(eq(businessCalendar.day, '2026-03-21'))
    expect(navruz).toEqual([{ kind: 'holiday' }])

    // Временный пароль: вход требует задать свой
    const login = await call(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'admin', password },
    })
    expect(login.statusCode, login.body).toBe(200)
    expect(login.json().status).toBe('password_change_required')
  })

  it('повторный запуск ничего не пересоздаёт и пароль не выдаёт', async () => {
    const again = await runInit({ adminLogin: 'admin', now })
    expect(again.migrations).toEqual([])
    expect(again.calendar).toEqual([
      { year: 2026, added: 0 },
      { year: 2027, added: 0 },
    ])
    expect(again.admin).toMatchObject({
      created: false,
      temporaryPassword: null,
      existing: ['admin'],
    })
    expect(formatInitSummary(again)).toContain('уже есть (admin)')
  })

  it('демо-данные ставятся поверх и используют того же администратора', async () => {
    const seeded = await seedCommand({ profile: 'minimal', reset: false })
    expect(seeded.units).toBeGreaterThan(0)

    const admins = await db()
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.login, 'admin'))
    // Администратор от init сохранён со своим временным паролем
    expect(admins).toEqual([{ mustChangePassword: true }])

    const repeated = await seedCommand({ profile: 'minimal', reset: false })
    expect(repeated.units).toBe(0)
  })

  it('недопустимый логин отклоняется до любых изменений', async () => {
    await expect(runInit({ adminLogin: 'не латиница', now })).rejects.toThrow()
  })

  it('заблокированный администратор не в счёт: создаётся новый', async () => {
    await db().update(users).set({ status: 'blocked' }).where(eq(users.login, 'admin'))
    const summary = await runInit({ adminLogin: 'root', now })
    expect(summary.admin).toMatchObject({ login: 'root', created: true, existing: [] })
    expect(summary.admin.temporaryPassword).toBeTruthy()
  })
})
