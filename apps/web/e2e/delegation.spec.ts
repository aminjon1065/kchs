import { expect, openWorkspace, test } from './fixtures.js'

test.use({ storageState: './e2e/.auth/employee.json' })

/**
 * Сценарий приёмки 6 (04-verification.md §3): сотрудник замещает коллегу,
 * видит баннер «Вы замещаете» и переключается в режим «от имени».
 */
test.describe('Замещение', () => {
  test('баннер «Вы замещаете» включает режим от имени', async ({ page, request, browser }) => {
    // Администратор назначает сотрудника своим заместителем на неделю
    const admin = await browser.newContext({
      baseURL: 'http://localhost:5173',
      storageState: './e2e/.auth/admin.json',
    })
    const adminApi = admin.request

    const me = await request.get('/api/v1/me')
    const employeeId = (await me.json()).user.id as string

    const adminMe = await adminApi.get('/api/v1/me')
    const adminCsrf = (await adminMe.json()).session.csrfToken as string
    const adminId = (await adminMe.json()).user.id as string

    const existing = await adminApi.get('/api/v1/me/delegations')
    for (const item of (await existing.json()).items as Array<{
      id: string
      fromUser: { id: string }
    }>) {
      if (item.fromUser.id === adminId) {
        await adminApi.delete(`/api/v1/me/delegations/${item.id}`, {
          headers: { 'x-csrf-token': adminCsrf },
        })
      }
    }

    const created = await adminApi.post('/api/v1/me/delegations', {
      headers: { 'x-csrf-token': adminCsrf },
      data: {
        toUserId: employeeId,
        scope: 'all',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        note: 'Отпуск',
      },
    })
    expect(created.ok(), 'замещение создано').toBeTruthy()

    try {
      await openWorkspace(page, request)

      const banner = page.getByText('Вы замещаете', { exact: true })
      await expect(banner).toBeVisible()

      // Включаем режим «от имени»
      await page.getByRole('combobox', { name: 'Вы замещаете' }).click()
      await page.getByRole('option').filter({ hasNotText: 'Действую от себя' }).first().click()

      await expect(page.getByRole('button', { name: 'Выйти из режима' })).toBeVisible()

      // Выход из режима
      await page.getByRole('button', { name: 'Выйти из режима' }).click()
      await expect(page.getByRole('button', { name: 'Выйти из режима' })).toBeHidden()
    } finally {
      const list = await adminApi.get('/api/v1/me/delegations')
      for (const item of (await list.json()).items as Array<{ id: string }>) {
        await adminApi.delete(`/api/v1/me/delegations/${item.id}`, {
          headers: { 'x-csrf-token': adminCsrf },
        })
      }
      await admin.close()
    }
  })
})
