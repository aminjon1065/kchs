import { describe, expect, it } from 'vitest'
import { createTranslator, isLocaleLoaded, loadLocale } from '../browser.js'

/**
 * Вход браузера (ADR-0166): в бандле только `ru`, остальные языки догружаются.
 * Отдельный файл — у vitest свой граф модулей на файл, серверный вход сюда не попадает.
 */
describe('вход браузера', () => {
  it('до загрузки — основной язык, после — перевод', async () => {
    expect(isLocaleLoaded('ru')).toBe(true)
    expect(isLocaleLoaded('en')).toBe(false)
    expect(createTranslator('en')('shell.status.jobs', { count: 1 })).toBe('1 задание')

    await loadLocale('en')
    expect(isLocaleLoaded('en')).toBe(true)
    expect(createTranslator('en')('shell.status.jobs', { count: 1 })).toBe('1 job')
    expect(isLocaleLoaded('tg')).toBe(false)
  })

  it('набор экспортов — как у серверного входа', async () => {
    const server = await import('../index.js')
    const browser = await import('../browser.js')
    expect(Object.keys(browser).sort()).toEqual(Object.keys(server).sort())
  })
})
