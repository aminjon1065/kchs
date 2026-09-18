import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/** Администрирование (P0-E15 S02): журнал аудита, объявления. */
registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

describe('журнал аудита', () => {
  it('выгрузка в CSV: заголовок, записи входа, сама выгрузка попадает в аудит', async () => {
    const response = await call(fx.app, {
      url: '/admin/audit/export.csv?action=user.login',
      as: fx.admin,
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/csv')
    expect(String(response.headers['content-disposition'])).toContain('kchs-audit-')
    const [header, ...rows] = response.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(header).toBe(
      'id,occurred_at,actor_id,actor,on_behalf_of,action,object_type,object_id,severity,ip,user_agent,details',
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.includes(',user.login'))).toBe(true)

    const trail = await call(fx.app, { url: '/admin/audit?action=audit.exported', as: fx.admin })
    expect(trail.json().items.length).toBeGreaterThan(0)
  })

  it('без права чтения аудита выгрузка недоступна', async () => {
    const response = await call(fx.app, { url: '/admin/audit/export.csv', as: fx.users.member })
    expect(response.statusCode).toBe(403)
  })

  it('ячейки-формулы экранируются против CSV-инъекции', async () => {
    const { csvCell } = await import('../src/modules/admin/module.js')
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell('+79001234567')).toBe("'+79001234567")
    expect(csvCell('обычный текст')).toBe('обычный текст')
    expect(csvCell('a,b')).toBe('"a,b"')
  })
})

describe('объявления', () => {
  const publish = (payload: Record<string, unknown>) =>
    call(fx.app, { method: 'POST', url: '/admin/announcements', as: fx.admin, payload })
  const shown = async () => {
    const response = await call(fx.app, { url: '/announcements', as: fx.users.member })
    expect(response.statusCode).toBe(200)
    return response.json().items as Array<{ title: string; createdBy: { displayName: string } }>
  }

  it('сотрудник видит показываемые — важные выше; запланированное и снятое не видны', async () => {
    const drill = await publish({ title: 'Учения', body: 'Пятница, 10:00', severity: 'warning' })
    expect(drill.statusCode).toBe(200)
    await publish({
      title: 'Плановые работы',
      body: 'Сервис будет недоступен',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    await publish({ title: 'Шторм', body: 'Штормовое предупреждение', severity: 'critical' })
    await publish({ title: 'Столовая', body: 'Новое меню' })

    const titles = (await shown()).map((item) => item.title)
    expect(titles).toEqual(['Шторм', 'Учения', 'Столовая'])
    expect((await shown())[0]?.createdBy.displayName).toBeTruthy()

    const withdraw = await call(fx.app, {
      method: 'POST',
      url: `/admin/announcements/${drill.json().id}/withdraw`,
      as: fx.admin,
    })
    expect(withdraw.statusCode).toBe(200)
    expect((await shown()).map((item) => item.title)).toEqual(['Шторм', 'Столовая'])

    const all = await call(fx.app, { url: '/admin/announcements', as: fx.admin })
    const status = Object.fromEntries(
      all.json().items.map((item: { title: string; status: string }) => [item.title, item.status]),
    )
    expect(status).toEqual({
      Учения: 'ended',
      'Плановые работы': 'scheduled',
      Шторм: 'active',
      Столовая: 'active',
    })

    // Публикация и снятие — события в outbox и записи аудита
    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE type LIKE 'announcement.%' ORDER BY id`,
    )
    expect(events.map((row) => row.type).filter((type) => type.endsWith('withdrawn'))).toHaveLength(
      1,
    )
    expect(events.filter((row) => row.type === 'announcement.published')).toHaveLength(4)
    // Журнал аудита неизменяем и переживает очистку тестовых данных — своё объявление по id
    const trail = await call(fx.app, {
      url: '/admin/audit?action=announcement.withdrawn&limit=200',
      as: fx.admin,
    })
    expect(
      trail
        .json()
        .items.filter(
          (entry: { details: { announcementId?: string } }) =>
            entry.details.announcementId === drill.json().id,
        ),
    ).toHaveLength(1)
  })

  it('снятое до начала показа не появится и после начала', async () => {
    const soon = await publish({
      title: 'Отменённое',
      body: 'Не состоится',
      startsAt: new Date(Date.now() + 1500).toISOString(),
    })
    await call(fx.app, {
      method: 'POST',
      url: `/admin/announcements/${soon.json().id}/withdraw`,
      as: fx.admin,
    })
    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect((await shown()).map((item) => item.title)).not.toContain('Отменённое')
    const all = await call(fx.app, { url: '/admin/announcements', as: fx.admin })
    const cancelled = all
      .json()
      .items.find((item: { title: string }) => item.title === 'Отменённое')
    expect(cancelled.status).toBe('ended')
  })

  it('публикует только администратор системы; окончание раньше начала отклоняется', async () => {
    const byMember = await call(fx.app, {
      method: 'POST',
      url: '/admin/announcements',
      as: fx.users.member,
      payload: { title: 'Самовольно', body: '—' },
    })
    expect(byMember.statusCode).toBe(403)
    expect(
      (await call(fx.app, { url: '/admin/announcements', as: fx.users.member })).statusCode,
    ).toBe(403)

    const backwards = await publish({
      title: 'Назад во времени',
      body: '—',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date().toISOString(),
    })
    expect(backwards.statusCode).toBe(400)
  })
})

describe('роли и пространства в консоли', () => {
  it('матрица ролей: способности и число сотрудников; сотрудники с ролью', async () => {
    const roles = await call(fx.app, { url: '/roles', as: fx.admin })
    type RoleRow = { key: string; userCount: number; capabilities: string[] }
    const byKey = new Map<string, RoleRow>(
      roles.json().items.map((role: RoleRow) => [role.key, role] as const),
    )
    expect(byKey.get('system_admin')?.capabilities).toContain('admin.system')
    expect(byKey.get('system_admin')?.userCount).toBe(1)
    expect(byKey.get('employee')?.userCount).toBe(3)

    const holders = await call(fx.app, { url: '/users?roleKey=system_admin', as: fx.admin })
    expect(holders.json().items.map((user: { login: string }) => user.login)).toEqual([
      'admin_test',
    ])
  })

  it('все пространства с администраторами; администратор системы назначает нового — с аудитом', async () => {
    const list = await call(fx.app, { url: '/admin/spaces', as: fx.admin })
    expect(list.statusCode).toBe(200)
    const items = list.json().items as Array<{
      id: string
      kind: string
      memberCount: number
      admins: Array<{ id: string }>
    }>
    const space = items.find((item) => item.id === fx.spaceId)
    expect(space?.memberCount).toBe(3)
    expect(space?.admins.map((admin) => admin.id)).toEqual([fx.admin.id])
    // Личные пространства — только по запросу
    expect(items.some((item) => item.kind === 'personal')).toBe(false)

    const assign = await call(fx.app, {
      method: 'POST',
      url: `/admin/spaces/${fx.spaceId}/admins`,
      as: fx.admin,
      payload: { userId: fx.users.stranger.id },
    })
    expect(assign.statusCode).toBe(200)
    const found = await call(fx.app, { url: '/admin/spaces?q=Тестовое', as: fx.admin })
    expect(found.json().items[0].admins.map((admin: { id: string }) => admin.id)).toContain(
      fx.users.stranger.id,
    )
    const trail = await call(fx.app, {
      url: `/admin/audit?action=space.admin_assigned&objectId=${fx.spaceId}`,
      as: fx.admin,
    })
    expect(trail.json().items).toHaveLength(1)

    expect((await call(fx.app, { url: '/admin/spaces', as: fx.users.member })).statusCode).toBe(403)
  })
})
