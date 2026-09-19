import { describe, expect, it } from 'vitest'
import { pdfWithImage } from './pdf.js'

const latin1 = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')

describe('PDF листа печати', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9])
  const pdf = pdfWithImage({
    jpeg,
    width: 1754,
    height: 1240,
    page: [841.89, 595.28],
    title: 'Карта',
    created: new Date('2026-09-19T08:30:00Z'),
  })
  const text = latin1(pdf)

  it('заголовок, конец файла, изображение без перекодирования', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.endsWith('%%EOF\n')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 841.89 595.28]')
    expect(text).toContain('/Width 1754 /Height 1240')
    expect(text).toContain(`/Filter /DCTDecode /Length ${jpeg.length}`)
    const start = text.indexOf('stream\n') + 'stream\n'.length
    expect(Array.from(pdf.slice(start, start + jpeg.length))).toEqual(Array.from(jpeg))
    // Кириллица заголовка — UTF-16BE: «К» = U+041A
    expect(text).toContain('/Title <FEFF041A0430044004420430>')
    expect(text).toContain('/CreationDate (D:20260919083000Z)')
  })

  it('таблица xref указывает на объекты', () => {
    const xref = Number(/startxref\n(\d+)\n/.exec(text)?.[1])
    expect(text.slice(xref, xref + 4)).toBe('xref')
    const entries = text
      .slice(xref)
      .split('\n')
      .slice(3, 9)
      .map((line) => Number(line.slice(0, 10)))
    entries.forEach((offset, index) => {
      expect(text.slice(offset, offset + 8)).toBe(`${index + 1} 0 obj\n`)
    })
    // Каждая запись xref — ровно 20 байт
    expect(text.slice(xref).split('\n')[2]).toBe('0000000000 65535 f ')
  })
})
