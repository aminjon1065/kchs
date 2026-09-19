import { NOTEBOOK_DOC, NotebookCell, type NotebookCellInput } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { insertCells, notebookState, readNotebook } from './notebook-doc.js'

const DATASET = '01890000-0000-7000-8000-000000000001'

const cells = (input: NotebookCellInput[]) => input.map((cell) => NotebookCell.parse(cell))

const BODY = {
  cells: cells([
    {
      id: 'intro',
      kind: 'text',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Сводка за месяц' }] }],
      },
    },
    { id: 'q1', kind: 'query', datasetId: DATASET, sql: 'SELECT 1' },
    { id: 'ask', kind: 'ai', datasetId: DATASET, question: 'Сколько паводков?' },
  ]),
  params: { period: { unit: 'month' as const, from: 0, to: 0 }, territory: null },
}

function docOf(...updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return doc
}

describe('документ Yjs тетради', () => {
  it('JSON → документ → JSON без потерь', () => {
    expect(readNotebook(docOf(notebookState(BODY)))).toEqual(BODY)
  })

  it('начальное состояние детерминировано: два процесса не удваивают ячейки', () => {
    const first = notebookState(BODY)
    const second = notebookState(BODY)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    expect(readNotebook(docOf(first, second)).cells).toHaveLength(3)
  })

  it('перенос ячейки меняет только порядок: правка, идущая в ней, не теряется', () => {
    const alice = docOf(notebookState(BODY))
    const bob = docOf(Y.encodeStateAsUpdate(alice))
    // Алиса переносит текст в конец, Боб одновременно дописывает в него
    alice.transact(() => {
      const order = alice.getArray<string>(NOTEBOOK_DOC.order)
      order.delete(0, 1)
      order.push(['intro'])
    })
    const body = bob.getMap<Y.Map<unknown>>(NOTEBOOK_DOC.cells).get('intro')?.get('body')
    if (!(body instanceof Y.XmlFragment)) throw new Error('нет текста ячейки intro')
    ;((body.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(15, ' и паводки', {})
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob))
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))

    for (const doc of [alice, bob]) {
      const read = readNotebook(doc)
      expect(read.cells.map((item) => item.id)).toEqual(['q1', 'ask', 'intro'])
      const text = read.cells.find((item) => item.kind === 'text')
      expect(JSON.stringify(text)).toContain('Сводка за месяц и паводки')
    }
  })

  it('одновременный перенос одной ячейки двумя авторами не удваивает её', () => {
    const alice = docOf(notebookState(BODY))
    const bob = docOf(Y.encodeStateAsUpdate(alice))
    alice.getArray<string>(NOTEBOOK_DOC.order).delete(2, 1)
    alice.getArray<string>(NOTEBOOK_DOC.order).insert(0, ['ask'])
    bob.getArray<string>(NOTEBOOK_DOC.order).delete(2, 1)
    bob.getArray<string>(NOTEBOOK_DOC.order).insert(1, ['ask'])
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob))
    expect(readNotebook(alice).cells.map((item) => item.id)).toHaveLength(3)
  })

  it('ячейка, не прошедшая контракт, в снимок не попадает; занятый идентификатор получает суффикс', () => {
    const doc = docOf(notebookState(BODY))
    doc.transact(() => {
      const broken = new Y.Map<unknown>()
      broken.set('kind', 'query')
      broken.set('datasetId', 'не-uuid')
      doc.getMap(NOTEBOOK_DOC.cells).set('broken', broken)
      doc.getArray<string>(NOTEBOOK_DOC.order).push(['broken', 'missing'])
    })
    insertCells(doc, cells([{ id: 'q1', kind: 'metric' }]), 0)
    const read = readNotebook(doc)
    expect(read.cells.map((item) => `${item.id}:${item.kind}`)).toEqual([
      'q1-2:metric',
      'intro:text',
      'q1:query',
      'ask:ai',
    ])
  })
})
