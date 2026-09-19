import type { RichBody } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { fragmentToRichBody, richBodyToFragment } from './rich-text.js'

/** Фрагмент в документе: так его видят клиенты и сервер. */
function roundTrip(body: RichBody): RichBody {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('body')
  richBodyToFragment(body, fragment)
  return fragmentToRichBody(fragment)
}

describe('текст Tiptap ↔ Y.XmlFragment', () => {
  it('заголовки, абзацы с метками, списки и перевод строки переживают перевод', () => {
    const body: RichBody = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Паводки' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ущерб ' },
            { type: 'text', text: 'вырос', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            {
              type: 'text',
              text: 'сводка',
              marks: [{ type: 'link', attrs: { href: 'https://kchs.tj/svodka' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Хатлон' }] }],
            },
          ],
        },
      ],
    }
    expect(roundTrip(body)).toEqual(body)
  })

  it('чужие узлы, метки и опасные ссылки отбрасываются', () => {
    const body = {
      type: 'doc',
      content: [
        { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
        {
          type: 'paragraph',
          attrs: { onclick: 'x' },
          content: [
            {
              type: 'text',
              text: 'ссылка',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: ' шрифт',
              marks: [{ type: 'textStyle', attrs: { color: 'red' } }],
            },
          ],
        },
      ],
    } as RichBody
    expect(roundTrip(body)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ссылка шрифт' }] }],
    })
  })

  it('содержимое, записанное клиентом в обход редактора, читается в пределах белого списка', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('body')
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    paragraph.insert(0, [text])
    const unknown = new Y.XmlElement('iframe')
    unknown.setAttribute('src', 'https://evil.example')
    fragment.insert(0, [paragraph, unknown])
    text.insert(0, 'жирный', { bold: {}, 'link--a1b2': { href: 'https://kchs.tj' } })
    // Без атрибутов Y.Text продолжил бы формат соседа — явно пустые
    text.insert(6, ' и обычный', {})
    expect(fragmentToRichBody(fragment)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'жирный',
              marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://kchs.tj' } }],
            },
            { type: 'text', text: ' и обычный' },
          ],
        },
      ],
    })
  })
})
