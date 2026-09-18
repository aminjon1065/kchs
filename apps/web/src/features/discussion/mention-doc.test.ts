import { describe, expect, it } from 'vitest'
import { composeMessage, mentionQuery, toDoc } from './mention-doc.js'

const ivanov = { id: 'u1', name: 'Иванов Иван' }
const ivanovShort = { id: 'u2', name: 'Иванов' }

describe('mentionQuery', () => {
  it('«@» и начало имени перед курсором — запрос с позицией «@»', () => {
    expect(mentionQuery('привет @Ива', 11)).toEqual({ query: 'Ива', start: 7 })
    expect(mentionQuery('@Ива', 4)).toEqual({ query: 'Ива', start: 0 })
  })

  it('без упоминания и внутри адреса почты запроса нет', () => {
    expect(mentionQuery('привет', 6)).toBeNull()
    expect(mentionQuery('ivanov@mail', 11)).toBeNull()
    // Пробел после имени закрывает упоминание
    expect(mentionQuery('@Иванов ', 8)).toBeNull()
  })

  it('учитывается только текст до курсора', () => {
    expect(mentionQuery('@Ива и дальше', 4)).toEqual({ query: 'Ива', start: 0 })
  })
})

describe('toDoc', () => {
  it('упоминания — узлы с идентификатором, остальное — текст', () => {
    expect(toDoc('@Иванов Иван проверьте', [ivanov])).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: 'u1', label: 'Иванов Иван' } },
            { type: 'text', text: ' проверьте' },
          ],
        },
      ],
    })
  })

  it('из совпадающих в одной позиции имён берётся самое длинное', () => {
    const doc = toDoc('@Иванов Иван и @Иванов', [ivanovShort, ivanov])
    expect(doc.content?.[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: 'u1', label: 'Иванов Иван' } },
        { type: 'text', text: ' и ' },
        { type: 'mention', attrs: { id: 'u2', label: 'Иванов' } },
      ],
    })
  })
})

describe('composeMessage', () => {
  it('пустое сообщение не отправляется', () => {
    expect(composeMessage('   ', [ivanov])).toBeNull()
  })

  it('упоминание, стёртое из текста, не уведомляет', () => {
    const message = composeMessage(' просто текст ', [ivanov])
    expect(message?.text).toBe('просто текст')
    expect(message?.mentions).toEqual([])
  })

  it('оставшиеся упоминания уходят списком идентификаторов', () => {
    expect(composeMessage('@Иванов Иван, срочно', [ivanov])?.mentions).toEqual(['u1'])
  })
})
