/**
 * Лист PDF с одним изображением JPEG во всю страницу (P2-E02 S06, ADR-0074):
 * печать карты без сервера и без сторонних библиотек. PDF 1.4 — каталог,
 * страница, образ XObject (`DCTDecode`: JPEG как есть), поток содержимого и
 * сведения документа (заголовок — UTF-16BE, как требует PDF для кириллицы).
 */

const encoder = new TextEncoder()

/** Строка PDF в UTF-16BE с меткой порядка байтов, шестнадцатеричной записью. */
function textString(text: string): string {
  let hex = 'FEFF'
  for (let index = 0; index < text.length; index++) {
    hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')
  }
  return `<${hex}>`
}

/** Дата PDF: `D:ГГГГММДДччммссZ`. */
function pdfDate(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

const num = (value: number) => Number(value.toFixed(2)).toString()

export function pdfWithImage(input: {
  /** Сжатое изображение JPEG (RGB). */
  jpeg: Uint8Array
  /** Размер изображения, пиксели. */
  width: number
  height: number
  /** Размер страницы, пункты (1/72 дюйма). */
  page: readonly [number, number]
  title: string
  created?: Date
}): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (id: number, ...parts: Array<string | Uint8Array>) => {
    offsets[id] = length
    push(`${id} 0 obj\n`)
    for (const part of parts) push(part)
    push('\nendobj\n')
  }

  const [pageWidth, pageHeight] = input.page
  const content = `q ${num(pageWidth)} 0 0 ${num(pageHeight)} 0 0 cm /Im0 Do Q`

  push('%PDF-1.4\n')
  // Двоичная строка-комментарий: файл с изображением — двоичный
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>',
  )
  object(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${input.width} /Height ${input.height} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
      `/Length ${input.jpeg.length} >>\nstream\n`,
    input.jpeg,
    '\nendstream',
  )
  object(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`)
  object(
    6,
    `<< /Title ${textString(input.title)} /Producer (kchs) /CreationDate (${pdfDate(input.created ?? new Date())}) >>`,
  )

  const xref = length
  const count = offsets.length
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
