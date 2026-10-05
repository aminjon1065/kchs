import { describe, expect, it, vi } from 'vitest'
import {
  createTranslator,
  dictionariesVersion,
  isLocaleLoaded,
  isNamespaceLoaded,
  loadLocale,
  loadNamespaces,
  subscribeDictionaries,
} from '../browser.js'

/**
 * Вход браузера (ADR-0166, ADR-0191): в бандле — неймспейсы оболочки `ru`, остальное
 * догружается. Отдельный файл — у vitest свой граф модулей на файл, серверный вход сюда не
 * попадает. Тесты идут по порядку и делят состояние загруженных словарей.
 */
describe('вход браузера', () => {
  it('в бандле — оболочка ru; другие языки и модульные неймспейсы — по запросу', async () => {
    expect(isLocaleLoaded('ru')).toBe(true)
    expect(isNamespaceLoaded('ru', 'shell')).toBe(true)
    expect(isNamespaceLoaded('ru', 'data')).toBe(false)
    expect(isLocaleLoaded('en')).toBe(false)
    expect(createTranslator('en')('shell.status.jobs', { count: 1 })).toBe('1 задание')

    await loadLocale('en')
    expect(isLocaleLoaded('en')).toBe(true)
    expect(createTranslator('en')('shell.status.jobs', { count: 1 })).toBe('1 job')
    expect(isNamespaceLoaded('en', 'data')).toBe(false)
    expect(isLocaleLoaded('tg')).toBe(false)
  })

  it('модульный неймспейс грузится по объявлению, а при смене языка — и на новом', async () => {
    await loadNamespaces('ru', ['data', 'common'])
    expect(createTranslator('ru')('data.explore.title')).toBe('Исследование')

    await loadLocale('tg')
    expect(isLocaleLoaded('tg')).toBe(true)
    expect(isNamespaceLoaded('tg', 'data')).toBe(true)
    expect(createTranslator('tg')('data.explore.title')).toBe('Тадқиқ')
    expect(isNamespaceLoaded('tg', 'gis')).toBe(false)
  })

  it('ключ необъявленного неймспейса: пустая строка, загрузка и сигнал перерисовки', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const version = dictionariesVersion()
    const changed = new Promise<void>((resolve) => {
      const stop = subscribeDictionaries(() => {
        stop()
        resolve()
      })
    })

    expect(createTranslator('ru')('alerts.title')).toBe('')
    await changed
    expect(dictionariesVersion()).toBe(version + 1)
    expect(createTranslator('ru')('alerts.title')).toBe('Алерты')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('объявленный, но ещё не загруженный неймспейс — пустая строка без предупреждения', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loading = loadNamespaces('ru', ['forms'])
    expect(createTranslator('ru')('forms.title')).toBe('')
    await loading
    expect(createTranslator('ru')('forms.title')).toBe('Формы сбора')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('неизвестный ключ и ключ загруженного неймспейса без перевода — сам ключ', () => {
    expect(createTranslator('ru')('nope.nope')).toBe('nope.nope')
    expect(createTranslator('ru')('shell.nope')).toBe('shell.nope')
    expect(createTranslator('ru')('nope')).toBe('nope')
  })

  it('набор экспортов — как у серверного входа', async () => {
    const server = await import('../index.js')
    const browser = await import('../browser.js')
    expect(Object.keys(browser).sort()).toEqual(Object.keys(server).sort())
  })
})
