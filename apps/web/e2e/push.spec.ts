import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Push и PWA (P4-E02 S08, ADR-0094): страница отдаёт манифест и регистрирует
 * служебный поток, карточка профиля появляется только когда на установке
 * заданы ключи VAPID (иначе push выключен и кнопок нет).
 */
test.describe('Push-уведомления и PWA', () => {
  test('манифест, иконки и служебный поток', async ({ page, request }) => {
    await openWorkspace(page, request)

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifestHref).toBe('/manifest.webmanifest')
    const manifest = await request.get('/manifest.webmanifest')
    expect(manifest.ok(), await manifest.text()).toBeTruthy()
    const parsed = (await manifest.json()) as {
      name: string
      display: string
      icons: Array<{ src: string; sizes: string }>
    }
    expect(parsed.display).toBe('standalone')
    expect(parsed.icons.map((icon) => icon.sizes)).toContain('512x512')
    for (const icon of parsed.icons) {
      const file = await request.get(icon.src)
      expect(file.ok(), icon.src).toBeTruthy()
    }

    // Служебный поток регистрируется оболочкой и переживает перезагрузку
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration('/').then(Boolean)), {
        timeout: 20_000,
      })
      .toBe(true)
    const scope = await page.evaluate(() =>
      navigator.serviceWorker.getRegistration('/').then((registration) => registration?.scope),
    )
    expect(scope).toMatch(/\/$/)
  })

  test('карточка push в профиле — по состоянию установки', async ({ page, request }) => {
    await openWorkspace(page, request)
    const status = await request.get('/api/v1/me/push')
    expect(status.ok(), await status.text()).toBeTruthy()
    const enabled = ((await status.json()) as { enabled: boolean }).enabled

    await page.goto('/profile')
    // Заголовки карточек дизайн-системы — не заголовки документа (известное ограничение)
    const card = page.getByText('Уведомления браузера', { exact: true })
    if (enabled) {
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: 'Включить на этом устройстве' })).toBeVisible()
    } else {
      // Экран профиля открыт (карточка внешнего вида есть всегда), push-карточки нет
      await expect(page.getByText('Внешний вид', { exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(card).toHaveCount(0)
    }
  })
})
