import { expect, type Page, test } from '@playwright/test'

/**
 * SqlEditor в браузере: строгий CSP (ADR-0043), клавиатура, автодополнение по
 * «человеческим» именам таблиц и полей. Снимки и axe историй — в stories.spec.ts.
 *
 * CSP — та же политика стилей, что у Caddy (`style-src 'self' 'nonce-…'`). Storybook
 * держит в iframe.html встроенные скрипты и стили — им проверка раздаёт тот же nonce,
 * как Caddy раздаёт его <meta name="csp-nonce">: иначе упала бы обвязка, а не редактор.
 */

const NONCE = 'b7f2a6d4-1c3e-4f5a-9b8c-2d4e6f8a0b1c'
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

/** iframe.html под строгим CSP; `meta` — отдавать ли nonce приложению (setCspNonce). */
async function strictCsp(page: Page, { meta }: { meta: boolean }): Promise<void> {
  await page.route('**/iframe.html*', async (route) => {
    const response = await route.fetch()
    let body = (await response.text())
      .replaceAll('<script', `<script nonce="${NONCE}"`)
      .replaceAll('<style', `<style nonce="${NONCE}"`)
      // Подсветка элементов Storybook вставляет свой <style> без nonce — в приложении её нет
      .replace('"highlight":true', '"highlight":false')
    if (meta) body = body.replace('<head>', `<head><meta name="csp-nonce" content="${NONCE}">`)
    await route.fulfill({
      response,
      body,
      headers: { ...response.headers(), 'content-security-policy': CSP },
    })
  })
  await page.addInitScript(() => {
    // Как apps/web/src/app/zod-jitless.ts: zod без проверки new Function (схемы контрактов)
    ;(globalThis as { __zod_globalConfig?: object }).__zod_globalConfig = { jitless: true }
    const violations: string[] = []
    ;(window as Window).__cspViolations = violations
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(
        `${event.violatedDirective}: ${event.blockedURI} ${event.sample} (${event.sourceFile}:${event.lineNumber}:${event.columnNumber})`,
      )
    })
  })
}

const violations = (page: Page) => page.evaluate(() => (window as Window).__cspViolations ?? [])

async function openStory(page: Page, id: string): Promise<void> {
  await page.goto(`/iframe.html?id=composites-sql-editor--${id}&viewMode=story`)
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

const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL-запрос' })
const text = (page: Page) => editor(page).evaluate((node) => (node as HTMLElement).innerText)

test('SqlEditor: строгий CSP — стили CodeMirror с nonce, нарушений нет', async ({ page }) => {
  await strictCsp(page, { meta: true })
  await openStory(page, 'with-completion')
  // История открыла подсказки; тема CodeMirror применена (<style> с nonce принят)
  await expect(page.getByRole('listbox', { name: 'Подсказки' })).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCSS('display', 'flex')
  await expect(page.locator('.cm-sqlParam').first()).toHaveCSS('border-top-left-radius', '4px')
  const nonce = await page.evaluate(
    () =>
      [...document.querySelectorAll('style')].find((node) =>
        node.textContent?.includes('.cm-scroller'),
      )?.nonce,
  )
  expect(nonce).toBe(NONCE)

  // Поиск и замена — панель со своими полями и кнопками
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+F')
  await page.getByRole('textbox', { name: 'Найти' }).fill('Район')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-searchMatch').first()).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await violations(page)).toEqual([])

  // Ошибка: подсказка у курсора и при наведении
  await openStory(page, 'with-error')
  await expect(page.locator('.cm-tooltip-lint')).toBeVisible()
  await page.locator('.cm-lintRange-error').hover()
  await expect(page.locator('.cm-tooltip-hover .cm-tooltip-lint')).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('SqlEditor: без nonce стили CodeMirror отбрасываются — проверка это ловит', async ({
  page,
}) => {
  await strictCsp(page, { meta: false })
  await openStory(page, 'empty')
  await expect(page.locator('[data-sql-editor-state="ready"]')).toBeVisible()
  await expect.poll(async () => (await violations(page)).join('\n')).toContain('style-src')
  await expect(page.locator('.cm-editor')).not.toHaveCSS('display', 'flex')
})

test('SqlEditor: подсказки по «человеческим» именам, параметры, клавиатура', async ({ page }) => {
  await openStory(page, 'empty')
  const field = editor(page)
  await field.click()

  // Таблица по названию датасета
  await page.keyboard.type('SELECT * FROM про')
  const list = page.getByRole('listbox', { name: 'Подсказки' })
  await expect(list.getByRole('option').first()).toContainText('Происшествия')
  await page.keyboard.press('Enter')

  // Поле через псевдоним: по подписи — в кавычках, Tab принимает подсказку
  await page.keyboard.type(' AS п WHERE п.дат')
  await expect(list.getByRole('option').first()).toContainText('Дата происшествия')
  await page.keyboard.press('Tab')

  // Поле по ключу — вставляется ключ
  await page.keyboard.type(' >= {{')
  await expect(list.getByRole('option').first()).toContainText('from')
  await page.keyboard.press('Enter')
  await page.keyboard.press('End')
  await page.keyboard.type(' AND п.vict')
  await expect(list.getByRole('option').first()).toContainText('victims')
  await page.keyboard.press('Enter')
  expect(await text(page)).toBe(
    'SELECT * FROM Происшествия AS п WHERE п."Дата происшествия" >= {{from}} AND п.victims',
  )

  // ⌘/Ctrl+Enter выполняет запрос
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('runs')).toHaveText('Выполнено: 1')

  // Tab без подсказки — отступ, фокус остаётся в редакторе
  await page.keyboard.press('Home')
  await page.keyboard.press('Tab')
  expect(await text(page)).toMatch(/^\s+SELECT/)
  await expect(field).toBeFocused()

  // Escape, затем Tab — выход из редактора
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(field).not.toBeFocused()
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor')))).toBe(
    false,
  )
})
