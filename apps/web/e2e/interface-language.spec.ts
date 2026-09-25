import { expect, test } from './fixtures.js'

/**
 * Язык интерфейса (ADR-0166): основной бандл несёт только словарь `ru`, словари `tg` и
 * `en` — отдельные чанки. Выбор языка догружает словарь; после перезагрузки интерфейс
 * сразу на выбранном языке. Проверяется на экране входа — без сессии и без записи в профиль.
 */
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Язык интерфейса', () => {
  test('таджикский и английский догружаются по выбору и переживают перезагрузку', async ({
    page,
  }) => {
    const loaded: string[] = []
    page.on('request', (request) => {
      // Сборка — чанки `tg-<хэш>.js`, стенд разработки — модули `locales/tg.ts`
      const match = /(?:\/|locales\/)(tg|en)(?:-[\w-]+\.js|\.ts)/.exec(request.url())
      if (match?.[1]) loaded.push(match[1])
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Вход в систему' })).toBeVisible()
    expect(loaded).toEqual([])

    // Самоназвания языков не переводятся — переключатель находится на любом языке
    await page.getByRole('radio', { name: 'Тоҷ' }).click()
    await expect(page.getByRole('heading', { name: 'Воридшавӣ ба система' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'tg')
    expect(loaded).toContain('tg')
    expect(loaded).not.toContain('en')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Воридшавӣ ба система' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ворид шудан', exact: true })).toBeVisible()

    await page.getByRole('radio', { name: 'Eng' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    await page.getByRole('radio', { name: 'Рус' }).click()
    await expect(page.getByRole('heading', { name: 'Вход в систему' })).toBeVisible()
  })
})
