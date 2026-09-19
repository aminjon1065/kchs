import { expect, type Page, test } from '@playwright/test'

/**
 * RichTextEditor в браузере: строгий CSP (ADR-0043) с курсорами соавторов,
 * форматирование с клавиатуры и панели, правка двух авторов в одном документе.
 * Снимки и axe историй — в stories.spec.ts.
 */

const NONCE = '3c9a41f2-7d6e-4b8a-a1f5-0e2d4c6b8a90'
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${NONCE}' 'report-sample'`,
  `style-src 'self' 'nonce-${NONCE}' 'report-sample'`,
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

type Window = typeof globalThis & { __cspViolations?: string[] }

/** iframe.html под строгим CSP, как у Caddy; обвязке Storybook — тот же nonce. */
async function strictCsp(page: Page): Promise<void> {
  await page.route('**/iframe.html*', async (route) => {
    const response = await route.fetch()
    const body = (await response.text())
      .replaceAll('<script', `<script nonce="${NONCE}"`)
      .replaceAll('<style', `<style nonce="${NONCE}"`)
      .replace('"highlight":true', '"highlight":false')
      .replace('<head>', `<head><meta name="csp-nonce" content="${NONCE}">`)
    await route.fulfill({
      response,
      body,
      headers: { ...response.headers(), 'content-security-policy': CSP },
    })
  })
  await page.addInitScript(() => {
    ;(globalThis as { __zod_globalConfig?: object }).__zod_globalConfig = { jitless: true }
    const violations: string[] = []
    ;(window as Window).__cspViolations = violations
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective}: ${event.blockedURI} ${event.sample}`)
    })
  })
}

async function openStory(page: Page, id: string): Promise<void> {
  await page.goto(`/iframe.html?id=composites-rich-text-editor--${id}&viewMode=story`)
  const phase = await page.waitForFunction(() => {
    const preview = (
      window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }
    ).__STORYBOOK_PREVIEW__
    const current = preview?.currentRender?.phase
    return current && ['completed', 'finished', 'errored', 'aborted'].includes(current)
      ? current
      : null
  })
  expect(await phase.jsonValue()).not.toBe('errored')
}

test('RichTextEditor: строгий CSP — курсор и выделение соавтора без встроенных стилей', async ({
  page,
}) => {
  await strictCsp(page)
  await openStory(page, 'collaboration')
  const caret = page.locator('.kchs-caret')
  await expect(caret.locator('.kchs-caret__label')).toHaveText('Алия Каримова')
  // Цвет курсора — токен палитры по оттенку, без атрибута style
  await expect(caret).not.toHaveAttribute('style')
  await expect(caret).toHaveCSS('border-left-style', 'solid')
  await expect(page.locator('.kchs-caret-selection')).toHaveText('выше нормы')
  expect(await page.evaluate(() => (window as Window).__cspViolations ?? [])).toEqual([])
})

test('RichTextEditor: форматирование с клавиатуры и панели, ссылка — только безопасный адрес', async ({
  page,
}) => {
  await openStory(page, 'default')
  const editor = page.getByRole('textbox', { name: 'Сводка' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Итог: ')
  await page.keyboard.press('ControlOrMeta+B')
  await page.keyboard.type('три района')
  await expect(editor.locator('strong', { hasText: 'три района' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Жирный' })).toHaveAttribute('aria-pressed', 'true')

  // Заголовок с панели: текущий абзац становится заголовком
  await page.getByRole('button', { name: 'Заголовок 3' }).click()
  await expect(editor.locator('h3', { hasText: 'Итог: три района' })).toBeVisible()

  // Ссылка javascript: не ставится, https — ставится
  await page.keyboard.press('Shift+Home')
  await page.getByRole('button', { name: 'Ссылка' }).click()
  const address = page.getByRole('textbox', { name: 'Адрес ссылки' })
  await address.fill('javascript:alert(1)')
  await page.getByRole('button', { name: 'Применить' }).click()
  await expect(page.getByText('Адрес начинается с http(s)://, mailto:, tel: или /')).toBeVisible()
  await address.fill('https://kchs.tj/itog')
  await page.getByRole('button', { name: 'Применить' }).click()
  await expect(editor.locator('a[href="https://kchs.tj/itog"]')).toBeVisible()

  // Отмена возвращает текст до заголовка
  await page.keyboard.press('ControlOrMeta+Z')
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(editor.locator('h3')).toHaveCount(0)
})

test('RichTextEditor: два автора — текст и курсор одного видны у другого', async ({ page }) => {
  await openStory(page, 'two-authors')
  const left = page.getByRole('textbox', { name: 'Сводка — Бахром Назаров' })
  const right = page.getByRole('textbox', { name: 'Сводка — Алия Каримова' })
  await left.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' Дежурный: Бахром.')
  await expect(right).toContainText('дамбы проверяются. Дежурный: Бахром.')
  await expect(right.locator('.kchs-caret__label')).toHaveText('Бахром Назаров')

  // Правка второго автора приходит первому, а отмена первого не трогает чужой текст.
  // Подпись чужого курсора стоит в тексте, но скрыта от скринридера — сверяем имена ролей
  const heading = { name: 'Срочно! Паводки: сводка за неделю' }
  await right.click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('Срочно! ')
  await expect(left.getByRole('heading', heading)).toBeVisible()
  await left.click()
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(left).not.toContainText('Дежурный: Бахром.')
  await expect(left.getByRole('heading', heading)).toBeVisible()
})
