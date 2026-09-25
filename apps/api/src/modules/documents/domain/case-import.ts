import type {
  CaseImportInput,
  CaseImportReport,
  CaseImportRow,
  CaseImportRowStatus,
} from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { authorize, requireCapability } from '~/kernel/access/authorize.js'
import { getObjectStream } from '~/kernel/storage/s3.js'
import { fileSource } from '~/modules/files/public.js'
import { OrgService } from '~/modules/identity/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { cases, documentTypes } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { readXlsx, writeXlsx, XlsxError, type XlsxSheet } from '~/shared/xlsx.js'
import { CaseService } from './case-service.js'
import { todayLocal } from './journal-service.js'
import { typicalCases } from './typical-nomenclature.js'

/** Файл номенклатуры — таблица на сотни строк: больше — явно не то. */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 2000

type Column = 'index' | 'title' | 'year' | 'unit' | 'retention' | 'retentionNote' | 'types' | 'note'

/** Заголовки столбцов: начало названия после свёртки регистра, «ё» и знаков. */
const HEADERS: ReadonlyArray<readonly [Column, readonly string[]]> = [
  ['index', ['индекс', 'index']],
  ['title', ['заголовок', 'наименование', 'title']],
  ['year', ['год', 'year']],
  ['unit', ['подразделение', 'структурное подразделение', 'unit']],
  ['retention', ['срок', 'retention']],
  ['retentionNote', ['статья', 'отметка', 'retention note']],
  ['types', ['типы', 'тип документов', 'types']],
  ['note', ['примечание', 'note']],
]

/** Шапка образца — в том же порядке, что и столбцы. */
const TEMPLATE_HEADER = [
  'Индекс',
  'Заголовок дела',
  'Год',
  'Подразделение',
  'Срок хранения, лет',
  'Статья перечня, отметка',
  'Типы документов',
  'Примечание',
]

function fold(text: string): string {
  return text
    .replace(/ё/gi, 'е')
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function columnOf(header: string): Column | null {
  const folded = fold(header)
  if (!folded) return null
  for (const [column, prefixes] of HEADERS) {
    if (prefixes.some((prefix) => folded.startsWith(prefix))) return column
  }
  return null
}

/** Лист и строка шапки: первая строка, где есть «Индекс» и «Заголовок». */
function locate(sheets: XlsxSheet[]): {
  sheet: XlsxSheet
  header: number
  map: Map<Column, number>
} {
  for (const sheet of sheets) {
    for (let row = 0; row < Math.min(sheet.rows.length, 10); row += 1) {
      const map = new Map<Column, number>()
      ;(sheet.rows[row] ?? []).forEach((cell, index) => {
        const column = columnOf(cell)
        if (column && !map.has(column)) map.set(column, index)
      })
      if (map.has('index') && map.has('title')) return { sheet, header: row, map }
    }
  }
  throw errors.validation(
    'В файле нет таблицы номенклатуры: нужны столбцы «Индекс» и «Заголовок дела»',
    [{ path: 'fileId', message: 'no_table' }],
  )
}

/** «5», «5 лет», «75 л.» — годы; «постоянно», «пост.» — null; иное — ошибка. */
function retentionOf(text: string): { years: number | null } | { error: string } {
  const folded = fold(text)
  if (folded.startsWith('пост')) return { years: null }
  const match = /^(\d{1,3})(?:\s|$)/.exec(folded)
  const years = match ? Number(match[1]) : Number.NaN
  if (Number.isInteger(years) && years >= 1 && years <= 100) return { years }
  return { error: 'Срок хранения — число лет от 1 до 100 или «постоянно»' }
}

async function fileBytes(ctx: UserCtx, fileId: string): Promise<Buffer> {
  await authorize(ctx, 'view', fileId)
  const source = await fileSource(fileId)
  if (!source) throw errors.notFound('Файл')
  if (source.size > MAX_BYTES) {
    throw errors.validation('Файл больше 5 МБ — для номенклатуры это слишком много', [
      { path: 'fileId', message: 'too_large' },
    ])
  }
  const object = await getObjectStream(source.storageKey, { bucket: source.bucket })
  const chunks: Buffer[] = []
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

const count = (rows: CaseImportRow[], status: CaseImportRowStatus) =>
  rows.filter((row) => row.status === status).length

/**
 * Импорт номенклатуры дел из Excel (N20, ADR-0135): проверка строк с понятными ошибками и
 * создание готовых дел одной транзакцией. Ведёт номенклатуру владелец «вести журналы».
 */
export const CaseImport = {
  /** Образец: типовая номенклатура на год и лист-справка с подразделениями и типами. */
  async template(ctx: UserCtx): Promise<Buffer> {
    requireCapability(ctx, 'documents.journals.manage')
    const year = Number(todayLocal().slice(0, 4))
    const [units, types] = await Promise.all([
      OrgService.tree(),
      db()
        .select({ key: documentTypes.key, name: documentTypes.name })
        .from(documentTypes)
        .where(eq(documentTypes.isActive, true))
        .orderBy(documentTypes.key),
    ])
    const unitName = new Map(units.map((unit) => [unit.code, unit.name.ru]))
    const typeName = new Map(types.map((type) => [type.key, type.name.ru]))
    const rows = typicalCases().map(({ section, index, item }) => [
      index,
      item.title,
      String(year),
      unitName.get(section.unitCode) ?? section.name,
      item.years === null ? 'постоянно' : String(item.years),
      item.note ?? '',
      (item.types ?? [])
        .map((key) => typeName.get(key))
        .filter((name): name is string => Boolean(name))
        .join('; '),
      '',
    ])
    return writeXlsx([
      {
        name: 'Номенклатура',
        header: true,
        widths: [10, 60, 8, 34, 18, 34, 34, 24],
        rows: [TEMPLATE_HEADER, ...rows],
      },
      {
        name: 'Как заполнять',
        header: true,
        widths: [28, 90],
        rows: [
          ['Столбец', 'Что писать'],
          ['Индекс', 'Индекс дела: индекс подразделения и номер дела в разделе, например 03-12'],
          ['Заголовок дела', 'Как в утверждённой номенклатуре'],
          ['Год', 'Год номенклатуры; пусто — год, выбранный при импорте'],
          ['Подразделение', 'Код или название подразделения из оргструктуры; можно пусто'],
          ['Срок хранения, лет', 'Число лет (1–100) или «постоянно»'],
          ['Статья перечня, отметка', 'Статья типового перечня, отметка ЭПК — текстом'],
          ['Типы документов', 'Коды или названия типов через «;» — дело будет предлагаться им'],
          ['Примечание', 'Свободный текст'],
          [],
          ['Подразделения', ''],
          ...units.filter((unit) => unit.isActive).map((unit) => [unit.code, unit.name.ru]),
          [],
          ['Типы документов', ''],
          ...types.map((type) => [type.key, type.name.ru]),
        ],
      },
    ])
  },

  async run(ctx: UserCtx, input: CaseImportInput): Promise<CaseImportReport> {
    requireCapability(ctx, 'documents.journals.manage')
    let sheets: XlsxSheet[]
    try {
      sheets = readXlsx(await fileBytes(ctx, input.fileId))
    } catch (error) {
      if (error instanceof XlsxError) {
        throw errors.validation(error.message, [{ path: 'fileId', message: 'not_xlsx' }])
      }
      throw error
    }
    const { sheet, header, map } = locate(sheets)
    const defaultYear = input.year ?? Number(todayLocal().slice(0, 4))

    const [units, types] = await Promise.all([
      OrgService.tree(),
      db()
        .select({ id: documentTypes.id, key: documentTypes.key, name: documentTypes.name })
        .from(documentTypes),
    ])
    const unitBy = new Map<string, { id: string; name: string }>()
    for (const unit of units) {
      unitBy.set(fold(unit.code), { id: unit.id, name: unit.name.ru })
      unitBy.set(fold(unit.name.ru), { id: unit.id, name: unit.name.ru })
    }
    const typeBy = new Map<string, string>()
    for (const type of types) {
      typeBy.set(fold(type.key), type.id)
      typeBy.set(fold(type.name.ru), type.id)
    }

    const cell = (row: string[], column: Column) => {
      const at = map.get(column)
      return at === undefined ? '' : (row[at] ?? '').trim()
    }
    const parsed: Array<
      CaseImportRow & {
        unitId: string | null
        typeIds: string[]
        note: string | null
        retentionNote: string | null
      }
    > = []
    const seen = new Set<string>()
    const body = sheet.rows.slice(header + 1)
    if (body.length > MAX_ROWS) {
      throw errors.validation(`В файле больше ${MAX_ROWS} строк — разделите номенклатуру`, [
        { path: 'fileId', message: 'too_many_rows' },
      ])
    }
    body.forEach((row, offset) => {
      if (row.every((value) => value.trim() === '')) return
      const messages: string[] = []
      const index = cell(row, 'index')
      const title = cell(row, 'title')
      if (!index) messages.push('Нет индекса дела')
      else if (index.length > 40) messages.push('Индекс длиннее 40 знаков')
      if (!title) messages.push('Нет заголовка дела')
      else if (title.length > 500) messages.push('Заголовок длиннее 500 знаков')

      const yearText = cell(row, 'year')
      const year = yearText ? Number(yearText) : defaultYear
      if (!Number.isInteger(year) || year < 1900 || year > 2100) {
        messages.push('Год — четыре цифры, например 2026')
      }

      const unitText = cell(row, 'unit')
      const unit = unitText ? unitBy.get(fold(unitText)) : undefined
      if (unitText && !unit) messages.push(`Подразделение «${unitText}» не найдено в оргструктуре`)

      const retentionText = cell(row, 'retention')
      let retentionYears: number | null = null
      if (!retentionText) messages.push('Нет срока хранения: число лет или «постоянно»')
      else {
        const retention = retentionOf(retentionText)
        if ('error' in retention) messages.push(retention.error)
        else retentionYears = retention.years
      }

      const typeIds: string[] = []
      for (const name of cell(row, 'types').split(/[;,\n]/)) {
        const trimmed = name.trim()
        if (!trimmed) continue
        const id = typeBy.get(fold(trimmed))
        if (id) typeIds.push(id)
        else messages.push(`Тип документов «${trimmed}» не найден`)
      }

      const key = `${year}:${index.toLocaleLowerCase('ru')}`
      if (index && seen.has(key)) messages.push('Индекс повторяется в файле для этого года')
      if (index) seen.add(key)

      parsed.push({
        row: header + offset + 2,
        index,
        title,
        year: Number.isInteger(year) ? year : null,
        unitName: unit?.name ?? (unitText || null),
        retentionYears,
        status: messages.length > 0 ? 'error' : 'ready',
        messages,
        unitId: unit?.id ?? null,
        typeIds: [...new Set(typeIds)],
        note: cell(row, 'note') || null,
        retentionNote:
          cell(row, 'retentionNote') ||
          (retentionYears === null && retentionText ? 'Хранится постоянно' : null),
      })
    })

    // Уже заведённые дела (индекс уникален в году) — не ошибка: импорт их пропускает
    const ready = parsed.filter((row) => row.status === 'ready' && row.year !== null)
    const years = [...new Set(ready.map((row) => row.year as number))]
    if (years.length > 0) {
      const existing = await db()
        .select({ index: cases.index, year: cases.year })
        .from(cases)
        .where(inArray(cases.year, years))
      const taken = new Set(
        existing.map((row) => `${row.year}:${row.index.toLocaleLowerCase('ru')}`),
      )
      for (const row of ready) {
        if (taken.has(`${row.year}:${row.index.toLocaleLowerCase('ru')}`)) {
          row.status = 'exists'
          row.messages = ['Дело с таким индексом в этом году уже есть — пропускается']
        }
      }
    }

    if (input.mode === 'apply') {
      const toCreate = parsed.filter((row) => row.status === 'ready')
      await db().transaction(async (tx) => {
        for (const row of toCreate) {
          await CaseService.create(tx, ctx, {
            index: row.index,
            title: row.title,
            year: row.year as number,
            unitId: row.unitId,
            retentionYears: row.retentionYears,
            retentionNote: row.retentionNote,
            documentTypeIds: row.typeIds,
            note: row.note,
          })
          row.status = 'created'
        }
      })
    }

    const rows: CaseImportRow[] = parsed.map(
      ({ unitId: _unit, typeIds: _types, note: _note, retentionNote: _retention, ...row }) => row,
    )
    return {
      mode: input.mode,
      sheet: sheet.name,
      rows,
      counts: {
        ready: count(rows, 'ready'),
        exists: count(rows, 'exists'),
        error: count(rows, 'error'),
        created: count(rows, 'created'),
      },
    }
  },
}
