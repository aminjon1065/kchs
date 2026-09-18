import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Каждая история собранного Storybook: снимок в светлой и тёмной теме
 * и проверка доступности axe (серьёзные и критичные нарушения — ошибка).
 * Тег истории `no-visual` исключает снимок, `no-axe` — проверку доступности.
 */
interface IndexEntry {
  id: string
  title: string
  name: string
  type: 'story' | 'docs'
  tags?: string[]
}

const index = JSON.parse(
  readFileSync(new URL('../storybook-static/index.json', import.meta.url), 'utf8'),
) as { entries: Record<string, IndexEntry> }

const stories = Object.values(index.entries).filter((entry) => entry.type === 'story')
const THEMES = ['light', 'dark'] as const

async function openStory(page: Page, id: string, theme: (typeof THEMES)[number]): Promise<void> {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`)
  // История отрисована и play-функция (если есть) завершилась
  const phase = await page.waitForFunction(() => {
    const preview = (
      window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }
    ).__STORYBOOK_PREVIEW__
    const current = preview?.currentRender?.phase
    return current && ['completed', 'finished', 'errored', 'aborted'].includes(current)
      ? current
      : null
  })
  expect(await phase.jsonValue(), `история ${id} отрисована без ошибок`).not.toBe('errored')

  // Фаза после исключения при отрисовке всё равно доходит до completed/finished,
  // поэтому ошибку ловим по экрану ошибки Storybook: иначе он станет эталоном снимка
  const failure = await page.evaluate(() => {
    if (document.body.classList.contains('sb-show-errordisplay')) {
      return document.getElementById('error-message')?.textContent?.trim() || 'экран ошибки'
    }
    const root = document.getElementById('storybook-root')
    return root && root.childElementCount === 0 ? 'история ничего не отрисовала' : null
  })
  expect(failure, `история ${id} отрисована без ошибок`).toBeNull()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

test.describe.configure({ mode: 'parallel' })

for (const story of stories) {
  const tags = story.tags ?? []
  for (const theme of THEMES) {
    test(`${story.title} / ${story.name} — ${theme}`, async ({ page }) => {
      await openStory(page, story.id, theme)

      if (!tags.includes('no-visual')) {
        await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`, { fullPage: true })
      }

      // Контраст и роли проверяются в светлой теме; тёмная проверена скриптом контраста токенов
      if (theme === 'light' && !tags.includes('no-axe')) {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          // Изолированный компонент — не страница: ориентиры и заголовок страницы не нужны
          .disableRules(['region', 'landmark-one-main', 'page-has-heading-one'])
          .analyze()
        const blocking = results.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        )
        expect(
          blocking.map((violation) => ({
            rule: violation.id,
            impact: violation.impact,
            help: violation.help,
            targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
          })),
          `нарушения доступности в ${story.id}`,
        ).toEqual([])
      }
    })
  }
}
