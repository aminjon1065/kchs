import { describe, expect, it } from 'vitest'
import { createTranslator, translate } from '../translate.js'

describe('плюрализация', () => {
  const t = createTranslator('ru')

  it('русские формы: одна, несколько, много', () => {
    expect(t('shell.status.jobs', { count: 1 })).toBe('1 задание')
    expect(t('shell.status.jobs', { count: 3 })).toBe('3 задания')
    expect(t('shell.status.jobs', { count: 5 })).toBe('5 заданий')
    expect(t('shell.status.jobs', { count: 21 })).toBe('21 задание')
  })

  it('английские формы', () => {
    const en = createTranslator('en')
    expect(en('shell.status.jobs', { count: 1 })).toBe('1 job')
    expect(en('shell.status.jobs', { count: 4 })).toBe('4 jobs')
  })

  it('точная ветвь `=0` важнее категории', () => {
    expect(translate('ru', 'search.results', { count: 0 })).toBe('ничего не найдено')
    expect(translate('ru', 'search.results', { count: 2 })).toBe('2 результата')
  })

  it('агрегация уведомлений подставляет и число, и заголовок', () => {
    const text = t('notifications.aggregate', { count: 4, title: 'Регламент' })
    expect(text).toBe('4 изменения в «Регламент»')
  })
})

describe('подстановка', () => {
  const t = createTranslator('ru')

  it('обычные параметры', () => {
    expect(t('notifications.tpl.mention', { actor: 'Иванов', title: 'Отчёт' })).toBe(
      'Иванов упомянул вас в «Отчёт»',
    )
  })

  it('неизвестный параметр остаётся как есть', () => {
    expect(t('notifications.tpl.mention', { actor: 'Иванов' })).toContain('{title}')
  })

  it('неизвестный ключ возвращает сам ключ', () => {
    expect(t('nope.nope')).toBe('nope.nope')
  })

  it('локаль без ключа берёт русский текст', () => {
    const tg = createTranslator('tg')
    expect(tg('common.appName')).toBeTruthy()
  })
})
