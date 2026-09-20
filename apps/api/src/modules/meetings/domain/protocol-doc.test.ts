import { PROTOCOL_DOC, type ProtocolBlock } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { protocolState, readProtocol, setBlockTask, writeSummary } from './protocol-doc.js'

/**
 * Документ Yjs протокола ↔ JSON (ADR-0093): блоки по порядку, заголовок —
 * `Y.Text`, тело — текст Tiptap; начальное состояние детерминировано; блок, не
 * прошедший контракт, в снимок не попадает, но документ не ломает.
 */

const agenda = (id: string, title: string): ProtocolBlock => ({
  id,
  kind: 'agenda_item',
  title,
  body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] },
  speakerId: null,
})

const instruction = (id: string): ProtocolBlock => ({
  id,
  kind: 'instruction',
  title: 'Обследовать станции',
  body: { type: 'doc', content: [] },
  assigneeId: '01920000-0000-7000-8000-000000000001',
  dueAt: '2026-10-01',
  controllerId: null,
  taskId: null,
})

function docOf(blocks: ProtocolBlock[], summary: string | null = null): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, protocolState({ blocks, summary }))
  return doc
}

describe('документ протокола', () => {
  it('блоки и резюме переживают путь JSON → Yjs → JSON', () => {
    const blocks = [agenda('a1', 'Паводок'), instruction('i1')]
    const body = readProtocol(docOf(blocks, 'Коротко о главном'))
    expect(body.summary).toBe('Коротко о главном')
    expect(body.blocks).toEqual(blocks)
  })

  it('одинаковый вход даёт одинаковое состояние: слияние не удваивает блоки', () => {
    const blocks = [agenda('a1', 'Паводок')]
    const first = protocolState({ blocks, summary: null })
    const second = protocolState({ blocks, summary: null })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const merged = new Y.Doc()
    Y.applyUpdate(merged, first)
    Y.applyUpdate(merged, second)
    expect(readProtocol(merged).blocks).toHaveLength(1)
  })

  it('порядок блоков задаёт массив порядка, повтор идентификатора читается один раз', () => {
    const doc = docOf([agenda('a1', 'Первый'), agenda('a2', 'Второй')])
    doc.getArray<string>(PROTOCOL_DOC.order).insert(0, ['a2'])
    const titles = readProtocol(doc).blocks.map((block) => block.title)
    expect(titles).toEqual(['Второй', 'Первый'])
  })

  it('блок без вида и блок не по контракту в снимок не попадают', () => {
    const doc = docOf([agenda('a1', 'Паводок')])
    const broken = new Y.Map<unknown>()
    broken.set('kind', 'unknown')
    doc.getMap<Y.Map<unknown>>(PROTOCOL_DOC.blocks).set('x1', broken)
    doc.getArray<string>(PROTOCOL_DOC.order).push(['x1'])
    expect(readProtocol(doc).blocks.map((block) => block.id)).toEqual(['a1'])
  })

  it('ключ поручения пишется в блок, резюме — в метаданные', () => {
    const doc = docOf([instruction('i1')])
    setBlockTask(doc, 'i1', '01920000-0000-7000-8000-000000000009')
    writeSummary(doc, 'Итоги')
    const body = readProtocol(doc)
    expect(body.summary).toBe('Итоги')
    const block = body.blocks[0]
    expect(block?.kind === 'instruction' && block.taskId).toBe(
      '01920000-0000-7000-8000-000000000009',
    )
  })
})
