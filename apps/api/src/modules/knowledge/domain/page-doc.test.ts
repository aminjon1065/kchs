import { PAGE_DOC, PageBlock, type PageBlockInput } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { pageChunks } from './page-chunks.js'
import { pageDependencies, pageOutline, pageText } from './page-core.js'
import { insertPageBlocks, pageState, readPage } from './page-doc.js'

const CHART = '01890000-0000-7000-8000-000000000001'
const MAP = '01890000-0000-7000-8000-000000000002'
const PAGE = '01890000-0000-7000-8000-0000000000ff'

const blocks = (input: PageBlockInput[]) => input.map((block) => PageBlock.parse(block))

const text = (lines: Array<{ type: 'paragraph' | 'heading'; text: string; level?: number }>) => ({
  type: 'doc' as const,
  content: lines.map((line) =>
    line.type === 'heading'
      ? {
          type: 'heading',
          attrs: { level: line.level ?? 2 },
          content: [{ type: 'text', text: line.text }],
        }
      : { type: 'paragraph', content: [{ type: 'text', text: line.text }] },
  ),
})

const BLOCKS = blocks([
  {
    id: 'intro',
    kind: 'text',
    title: 'Порядок оповещения',
    body: text([
      { type: 'paragraph', text: 'Оповещение начинается с дежурного.' },
      { type: 'heading', text: 'Кто оповещает', level: 2 },
      { type: 'paragraph', text: 'Дежурный по управлению.' },
    ]),
  },
  {
    id: 'table',
    kind: 'table',
    title: 'Сроки',
    columns: ['Этап', 'Срок'],
    rows: [['Первый', '5 мин']],
  },
  { id: 'chart', kind: 'chart', chartId: CHART },
  { id: 'map', kind: 'map', mapId: MAP },
])

function docOf(...updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return doc
}

describe('документ Yjs страницы', () => {
  it('JSON → документ → JSON без потерь', () => {
    expect(readPage(docOf(pageState(BLOCKS)))).toEqual(BLOCKS)
  })

  it('начальное состояние детерминировано: два процесса не удваивают блоки', () => {
    const first = pageState(BLOCKS)
    const second = pageState(BLOCKS)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    expect(readPage(docOf(first, second))).toHaveLength(BLOCKS.length)
  })

  it('занятый идентификатор получает суффикс: блок не затирает другой', () => {
    const doc = docOf(pageState(BLOCKS))
    insertPageBlocks(doc, blocks([{ id: 'intro', kind: 'text', title: 'Другой' }]))
    const read = readPage(doc)
    expect(read).toHaveLength(BLOCKS.length + 1)
    expect(read.at(-1)?.id).toBe('intro-2')
    expect(read[0]?.title).toBe('Порядок оповещения')
  })

  it('перенос блока меняет только порядок: правка, идущая в нём, не теряется', () => {
    const alice = docOf(pageState(BLOCKS))
    const bob = docOf(Y.encodeStateAsUpdate(alice))
    alice.transact(() => {
      const order = alice.getArray<string>(PAGE_DOC.order)
      order.delete(0, 1)
      order.push(['intro'])
    })
    const body = bob.getMap<Y.Map<unknown>>(PAGE_DOC.blocks).get('intro')?.get('body')
    if (!(body instanceof Y.XmlFragment)) throw new Error('нет текста блока intro')
    ;((body.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(10, ' немедленно', {})
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob))
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))

    for (const doc of [alice, bob]) {
      const read = readPage(doc)
      expect(read.map((block) => block.id)).toEqual(['table', 'chart', 'map', 'intro'])
      expect(pageText(read)).toContain('немедленно')
    }
  })

  it('блок, не прошедший контракт, в снимок не попадает', () => {
    const doc = docOf(pageState(BLOCKS))
    const broken = new Y.Map<unknown>()
    broken.set('id', 'broken')
    broken.set('kind', 'text')
    doc.getMap<Y.Map<unknown>>(PAGE_DOC.blocks).set('broken', broken)
    doc.getArray<string>(PAGE_DOC.order).push(['broken'])
    // Вид известен, но `title` отсутствует — схема подставит значение по умолчанию
    expect(readPage(doc).map((block) => block.id)).toContain('broken')

    const alien = new Y.Map<unknown>()
    alien.set('id', 'alien')
    alien.set('kind', 'video')
    doc.getMap<Y.Map<unknown>>(PAGE_DOC.blocks).set('alien', alien)
    doc.getArray<string>(PAGE_DOC.order).push(['alien'])
    expect(readPage(doc).map((block) => block.id)).not.toContain('alien')
  })
})

describe('оглавление, текст и зависимости страницы', () => {
  it('оглавление: подпись блока — первый уровень, заголовки текста — вложенные', () => {
    expect(pageOutline(BLOCKS)).toEqual([
      { blockId: 'intro', index: 0, level: 1, text: 'Порядок оповещения' },
      { blockId: 'intro', index: 1, level: 3, text: 'Кто оповещает' },
      { blockId: 'table', index: 0, level: 1, text: 'Сроки' },
    ])
  })

  it('заголовок без подписи блока остаётся на своём уровне', () => {
    const plain = blocks([
      { id: 'a', kind: 'text', body: text([{ type: 'heading', text: 'Раздел', level: 1 }]) },
    ])
    expect(pageOutline(plain)).toEqual([{ blockId: 'a', index: 1, level: 1, text: 'Раздел' }])
  })

  it('текст страницы включает таблицу и не включает встроенные объекты', () => {
    const body = pageText(BLOCKS)
    expect(body).toContain('Дежурный по управлению.')
    expect(body).toContain('Этап\tСрок')
    expect(body).not.toContain(CHART)
  })

  it('зависимости — идентификаторы встроенных объектов', () => {
    expect(pageDependencies(BLOCKS).sort()).toEqual([CHART, MAP].sort())
  })

  it('чанки: по блоку с якорем и заголовком, пустые блоки пропускаются', () => {
    const chunks = pageChunks(PAGE, [...BLOCKS, ...blocks([{ id: 'empty', kind: 'text' }])])
    expect(chunks.map((chunk) => chunk.blockId)).toEqual(['intro', 'table'])
    expect(chunks[0]).toMatchObject({ id: `${PAGE}_intro_0`, heading: 'Порядок оповещения' })
    expect(chunks[1]?.text).toContain('Первый')
  })

  it('длинный текст режется на несколько чанков', () => {
    const long = 'Пункт порядка оповещения. '.repeat(120)
    const chunks = pageChunks(
      PAGE,
      blocks([
        {
          id: 'long',
          kind: 'text',
          body: text(long.split('. ').map((line) => ({ type: 'paragraph', text: line }))),
        },
      ]),
    )
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1800)
  })
})
