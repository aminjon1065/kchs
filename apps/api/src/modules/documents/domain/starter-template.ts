import { crc32 } from 'node:zlib'

/**
 * Стартовый шаблон исходящего письма (08-documents.md §8, ADR-0085): DOCX,
 * собранный из XML прямо в коде — ревью видит каждый плейсхолдер, а образу
 * api не нужен двоичный файл. Оформление — по ГОСТ Р 7.0.97: A4, поля 3 / 1,5 /
 * 2 / 2 см, Times New Roman 14 pt, реквизиты «Исп.» внизу мелким шрифтом.
 */

interface ZipEntry {
  name: string
  data: Buffer
}

/** ZIP без сжатия (метод 0) с UTF-8 именами — достаточно для пакета OOXML. */
export function zipStored(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // Время изменения фиксировано (1980-01-01): один и тот же шаблон — одни и те же байты
  const time = 0
  const date = (0 << 9) | (1 << 5) | 1
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, entry.data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + entry.data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface Run {
  text?: string
  tab?: boolean
  bold?: boolean
  size?: number
}

/** Абзац: выравнивание, отступы (twips), размер шрифта (pt). */
function paragraph(
  runs: Run[],
  options: {
    align?: 'left' | 'center' | 'right' | 'both'
    indentLeft?: number
    firstLine?: number
    tabRight?: number
  } = {},
): string {
  const props = [
    options.tabRight ? `<w:tabs><w:tab w:val="right" w:pos="${options.tabRight}"/></w:tabs>` : '',
    options.align ? `<w:jc w:val="${options.align}"/>` : '',
    options.indentLeft || options.firstLine
      ? `<w:ind w:left="${options.indentLeft ?? 0}" w:firstLine="${options.firstLine ?? 0}"/>`
      : '',
  ].join('')
  const body = runs
    .map((run) => {
      const rPr = [
        run.bold ? '<w:b/>' : '',
        run.size ? `<w:sz w:val="${run.size * 2}"/><w:szCs w:val="${run.size * 2}"/>` : '',
      ].join('')
      const content = run.tab
        ? '<w:tab/>'
        : `<w:t xml:space="preserve">${escapeXml(run.text ?? '')}</w:t>`
      return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content}</w:r>`
    })
    .join('')
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`
}

const blank = () => paragraph([])

/** Плейсхолдеры стартового шаблона — для проверки без разбора движком. */
export const STARTER_PLACEHOLDERS = [
  'org.name',
  'doc.fields.addressee',
  'doc.correspondent.name',
  'doc.correspondent.address',
  'doc.reg_number',
  'doc.reg_date',
  'doc.subject',
  'doc.summary',
  'doc.attachments',
  'signer.position',
  'signer.short_name',
  'author.short_name',
  'author.phone',
]

function documentXml(): string {
  const right = { indentLeft: 5102 }
  const body = [
    paragraph([{ text: '{{ org.name }}', bold: true }], { align: 'center' }),
    blank(),
    paragraph([{ text: '{{ doc.fields.addressee }}' }], right),
    paragraph([{ text: '{{ doc.correspondent.name }}' }], right),
    paragraph([{ text: '{{ doc.correspondent.address }}' }], right),
    blank(),
    paragraph([
      { text: "№ {{ doc.reg_number or '__________' }} от {{ doc.reg_date or '__________' }}" },
    ]),
    blank(),
    paragraph([{ text: '{{ doc.subject }}', bold: true }]),
    blank(),
    paragraph([{ text: '{{ doc.summary }}' }], { align: 'both', firstLine: 709 }),
    blank(),
    paragraph([{ text: '{%p if doc.attachments %}' }]),
    paragraph([{ text: 'Приложение:' }]),
    paragraph([{ text: '{%p for item in doc.attachments %}' }]),
    paragraph([{ text: '{{ loop.index }}. {{ item.name }}' }], { indentLeft: 709 }),
    paragraph([{ text: '{%p endfor %}' }]),
    blank(),
    paragraph([{ text: '{%p endif %}' }]),
    blank(),
    paragraph(
      [{ text: '{{ signer.position }}' }, { tab: true }, { text: '{{ signer.short_name }}' }],
      {
        tabRight: 9355,
      },
    ),
    blank(),
    blank(),
    paragraph([{ text: 'Исп.: {{ author.short_name }}', size: 10 }]),
    paragraph([{ text: '{{ author.phone }}', size: 10 }]),
  ].join('')
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr>'
  return `${XML}<w:document xmlns:w="${W}"><w:body>${body}${section}</w:body></w:document>`
}

const STYLES = `${XML}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`

const RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const DOCUMENT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

/** Бланк исходящего письма — пакет DOCX. */
export function outgoingLetterDocx(): Buffer {
  return zipStored([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCUMENT_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
  ])
}
