import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/** Администрирование (P0-E15 S02): выгрузка журнала аудита. */
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
