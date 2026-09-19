import { createTranslator } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'
import { parseQuickEvent, stemName, vocabFrom } from './quick-parse.js'

/** Понедельник 21 сентября 2026. */
const TODAY = '2026-09-21'
const ru = vocabFrom(createTranslator('ru'))
const en = vocabFrom(createTranslator('en'))

describe('быстрое создание события из фразы', () => {
  it('«Встреча завтра в 10 с Ивановым» — название, дата, время и участник', () => {
    expect(parseQuickEvent('Встреча завтра в 10 с Ивановым', TODAY, ru)).toEqual({
      title: 'Встреча',
      date: '2026-09-22',
      start: 600,
      end: null,
      allDay: false,
      people: ['Иванов'],
    })
  })

  it('день недели, промежуток «с … до …» и несколько участников', () => {
    const parsed = parseQuickEvent(
      'Совещание по паводку в пятницу с 14 до 15:30 с Петровой и Каримовым',
      TODAY,
      ru,
    )
    expect(parsed).toMatchObject({
      title: 'Совещание по паводку',
      date: '2026-09-25',
      start: 14 * 60,
      end: 15 * 60 + 30,
      people: ['Петров', 'Каримов'],
    })
  })

  it('дата числом и месяцем, длительность «на полчаса», «утра / вечера»', () => {
    expect(parseQuickEvent('Планёрка 25 сентября в 9 утра на полчаса', TODAY, ru)).toMatchObject({
      title: 'Планёрка',
      date: '2026-09-25',
      start: 9 * 60,
      end: 9 * 60 + 30,
    })
    expect(parseQuickEvent('Созвон 1.10 в 7 вечера', TODAY, ru)).toMatchObject({
      date: '2026-10-01',
      start: 19 * 60,
    })
    // «в 3» без уточнения — рабочее время, после полудня
    expect(parseQuickEvent('Звонок в 3', TODAY, ru)).toMatchObject({ date: TODAY, start: 15 * 60 })
  })

  it('прошедшая дата «5 марта» — следующий год; «весь день» — событие на день', () => {
    expect(parseQuickEvent('Отчёт 5 марта', TODAY, ru)).toMatchObject({
      date: '2027-03-05',
      allDay: true,
    })
    expect(parseQuickEvent('Командировка послезавтра весь день', TODAY, ru)).toMatchObject({
      title: 'Командировка',
      date: '2026-09-23',
      allDay: true,
      start: null,
    })
  })

  it('без даты и времени — не событие, а обычный поиск', () => {
    expect(parseQuickEvent('паводок Хатлон', TODAY, ru)).toBeNull()
    expect(parseQuickEvent('маршрут эвакуации', TODAY, ru)).toBeNull()
    // Слова, похожие на дни недели, не съедаются: «средства» — не среда
    expect(parseQuickEvent('Закупка средства завтра', TODAY, ru)).toMatchObject({
      title: 'Закупка средства',
      date: '2026-09-22',
    })
  })

  it('без названия — «Встреча»; английский словарь работает так же', () => {
    expect(parseQuickEvent('завтра в 11', TODAY, ru)?.title).toBe('Встреча')
    expect(parseQuickEvent('Review tomorrow at 10 with Ivanov', TODAY, en)).toMatchObject({
      title: 'Review',
      date: '2026-09-22',
      start: 600,
      people: ['Ivanov'],
    })
  })

  it('основа фамилии для поиска: окончание творительного падежа отбрасывается', () => {
    expect(stemName('Ивановым', ru.nameEndings)).toBe('Иванов')
    expect(stemName('Рахимовой', ru.nameEndings)).toBe('Рахимов')
    expect(stemName('Ли', ru.nameEndings)).toBe('Ли')
  })
})
