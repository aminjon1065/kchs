import { describe, expect, it } from 'vitest'
import { readXlsx, writeXlsx, writeZip, XlsxError } from './xlsx.js'

const part = (name: string, content: string) => ({ name, data: Buffer.from(content, 'utf8') })

/** Книга, как её пишет Excel: общие строки, форматированный текст, пропуски ячеек и строк. */
function excelLikeBook(): Buffer {
  return writeZip([
    part(
      'xl/workbook.xml',
      '<workbook xmlns:r="r"><sheets><sheet name="Номенклатура" sheetId="1" r:id="rId3"/><sheet name="Справка" sheetId="2" r:id="rId4"/></sheets></workbook>',
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId3" Target="worksheets/sheet1.xml"/><Relationship Id="rId4" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ),
    part(
      'xl/sharedStrings.xml',
      '<sst><si><t>Индекс</t></si><si><r><t>Заголовок </t></r><r><rPr><b/></rPr><t xml:space="preserve">дела</t></r><rPh><t>фонетика</t></rPh></si><si><t>Переписка &amp; «отчёты» &lt;2026&gt;</t></si></sst>',
    ),
    part(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>03-12</t></is></c><c r="C3"><v>5</v></c><c r="D3" t="b"><v>1</v></c></row><row r="4"><c r="B4" t="s"><v>2</v></c><c r="C4" s="2"/></row></sheetData></worksheet>',
    ),
    part('xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>'),
  ])
}

describe('таблицы Excel', () => {
  it('запись и чтение: строки, числа, индексы с нулём, закреплённая шапка', () => {
    const book = writeXlsx([
      {
        name: 'Номенклатура',
        header: true,
        widths: [10, 40],
        rows: [
          ['Индекс', 'Заголовок дела', 'Срок'],
          ['03-12', 'Донесения о ЧС <важно> & «срочно»', '5'],
          ['03', 'Раздел', ''],
        ],
      },
      { name: 'Справка', rows: [['Постоянно']] },
    ])
    const sheets = readXlsx(book)
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Номенклатура', 'Справка'])
    expect(sheets[0]?.rows).toEqual([
      ['Индекс', 'Заголовок дела', 'Срок'],
      ['03-12', 'Донесения о ЧС <важно> & «срочно»', '5'],
      ['03', 'Раздел'],
    ])
    expect(readXlsx(book, { sheet: 'Справка' })[0]?.rows).toEqual([['Постоянно']])
  })

  it('книга Excel: общие строки, форматированный текст, пропуски и логические значения', () => {
    const [sheet] = readXlsx(excelLikeBook())
    expect(sheet?.rows).toEqual([
      ['Индекс', 'Заголовок дела'],
      [],
      ['03-12', '', '5', 'TRUE'],
      ['', 'Переписка & «отчёты» <2026>', ''],
    ])
  })

  it('не книга Excel — понятная ошибка', () => {
    expect(() => readXlsx(Buffer.from('Индекс;Заголовок\n03-12;Дело'))).toThrow(XlsxError)
    expect(() => readXlsx(writeZip([part('word/document.xml', '<w/>')]))).toThrow(
      'Файл не похож на книгу Excel (.xlsx)',
    )
  })
})
