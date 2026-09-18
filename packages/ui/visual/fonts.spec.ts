import { expect, test } from '@playwright/test'

/**
 * Каждый знак истории «Типографика» нарисован собственными шрифтами дизайн-системы
 * (03-ui/02-design-system.md §Типографика, P0-E13 S03): Inter — для текста,
 * JetBrains Mono (и Noto Sans Mono для таджикских Ӣӣ Ӯӯ Ҳҳ) — для моноширинного.
 * Ни одного системного фолбэка: данные берутся у движка Chromium — какими шрифтами
 * он отрисовал текст узла.
 */
const EXPECTED: Record<string, RegExp> = {
  sans: /^Inter/,
  mono: /^(JetBrains Mono|Noto Sans Mono)/,
}

test('текст рисуется собственными шрифтами, включая таджикские буквы', async ({ page }) => {
  await page.goto('/iframe.html?id=foundations-typography--scale&viewMode=story')
  await page.locator('[data-font]').first().waitFor()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: '[data-font]',
  })
  expect(nodeIds.length).toBeGreaterThan(10)

  const used = new Set<string>()
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
    const kind = attributes[attributes.indexOf('data-font') + 1] ?? ''
    const expected = EXPECTED[kind]
    expect(expected, `неизвестный data-font="${kind}"`).toBeDefined()
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    expect(fonts.length).toBeGreaterThan(0)
    for (const font of fonts) {
      used.add(font.familyName)
      expect(font.isCustomFont, `${kind}: «${font.familyName}» — системный шрифт`).toBe(true)
      expect(font.familyName).toMatch(expected as RegExp)
    }
  }
  // Таджикские Ӣӣ Ӯӯ Ҳҳ в моноширинном тексте берутся из дополнения
  expect([...used].some((name) => name.startsWith('Noto Sans Mono'))).toBe(true)
})
