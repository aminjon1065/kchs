import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Импорт номенклатуры дел из Excel (N20, ADR-0135): образец с типовой номенклатурой,
 * проверка строк (подразделение по коду или названию, типы по коду или названию, срок —
 * число лет или «постоянно»), уже заведённые дела пропускаются, импорт заводит готовые.
 */
registerLifecycle()

const { writeXlsx, readXlsx } = await import('../src/shared/xlsx.js')
const { OrgService } = await import('../src/modules/identity/public.js')
const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const run = Date.now().toString(36)
const year = 2031

let fx: TestContext
let registrar: TestUser
let personalSpaceId = ''
const unitCode = `NOM-${run}`
const unitName = `Отдел номенклатуры ${run}`

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

async function upload(rows: string[][]): Promise<string> {
  const file = await uploadFile(fx.app, registrar, {
    spaceId: personalSpaceId,
    name: `номенклатура-${run}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: writeXlsx([{ name: 'Номенклатура', header: true, rows }]),
  })
  return file.id
}

async function importFile(fileId: string, mode: 'check' | 'apply'): Promise<Json> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/cases/import',
    as: registrar,
    payload: { fileId, mode, year },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  await DocumentsSeed.ensureStarterSet(systemCtx('test'))
  await db().transaction((tx) =>
    OrgService.createUnit(tx, systemCtx('test'), {
      code: unitCode,
      name: { ru: unitName },
      kind: 'division',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  registrar = await createUser(fx.app, `nomenclature_${run}`, ['employee', 'registrar'])
  const me = await call(fx.app, { url: '/me', as: registrar })
  personalSpaceId = me.json().personalSpaceId
}, 120_000)

describe('импорт номенклатуры из Excel', () => {
  it('образец — типовая номенклатура и справка по столбцам', async () => {
    const response = await call(fx.app, { url: '/cases/import/template.xlsx', as: registrar })
    expect(response.statusCode).toBe(200)
    const sheets = readXlsx((response as unknown as { rawPayload: Buffer }).rawPayload)
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Номенклатура', 'Как заполнять'])
    const [header, ...rows] = sheets[0]?.rows ?? []
    expect(header?.slice(0, 5)).toEqual([
      'Индекс',
      'Заголовок дела',
      'Год',
      'Подразделение',
      'Срок хранения, лет',
    ])
    expect(rows.find((row) => row[0] === '03-12')?.[1]).toBe('Донесения о чрезвычайных ситуациях')
    expect(rows.find((row) => row[0] === '01-02')?.[4]).toBe('постоянно')

    // Без права вести журналы образец не выдаётся
    const stranger = await call(fx.app, { url: '/cases/import/template.xlsx', as: fx.users.member })
    expect(stranger.statusCode).toBe(403)
  })

  it('проверка объясняет ошибки, импорт заводит готовые и пропускает заведённые', async () => {
    const existing = await call(fx.app, {
      method: 'POST',
      url: '/cases',
      as: registrar,
      payload: { index: `09-01-${run}`, title: 'Уже заведено', year, retentionYears: 3 },
    })
    expect(existing.statusCode, existing.body).toBe(200)

    const fileId = await upload([
      [
        'Индекс',
        'Наименование дела',
        'Год',
        'Структурное подразделение',
        'Срок хранения (лет)',
        'Статья перечня',
        'Типы документов',
        'Примечание',
      ],
      [
        `09-02-${run}`,
        'Служебные записки отдела',
        '',
        unitCode,
        '5 лет',
        'ст. 45',
        'memo; Исходящее письмо',
        '',
      ],
      [`09-03-${run}`, 'Положение об отделе', '', unitName, 'постоянно', '', '', 'До замены новым'],
      [`09-01-${run}`, 'Уже заведено', '', '', '3', '', '', ''],
      ['', 'Без индекса', '', '', 'пять', '', '', ''],
      [`09-04-${run}`, 'Чужое подразделение', '', 'Нет такого', '5', '', 'нет_типа', ''],
      [`09-02-${run}`, 'Повтор индекса', '', '', '5', '', '', ''],
      [],
    ])
    const checked = await importFile(fileId, 'check')
    expect(checked.counts).toEqual({ ready: 2, exists: 1, error: 3, created: 0 })
    const byRow = new Map<number, Json>(checked.rows.map((row: Json) => [row.row, row]))
    expect(byRow.get(2)).toMatchObject({ status: 'ready', unitName, retentionYears: 5, year })
    expect(byRow.get(3)).toMatchObject({ status: 'ready', retentionYears: null })
    expect(byRow.get(4)).toMatchObject({ status: 'exists' })
    expect(byRow.get(5).messages).toEqual([
      'Нет индекса дела',
      'Срок хранения — число лет от 1 до 100 или «постоянно»',
    ])
    expect(byRow.get(6).messages).toEqual([
      'Подразделение «Нет такого» не найдено в оргструктуре',
      'Тип документов «нет_типа» не найден',
    ])
    expect(byRow.get(7).messages).toEqual(['Индекс повторяется в файле для этого года'])

    // Проверка ничего не создаёт
    const before = await call(fx.app, { url: `/cases?year=${year}&q=${run}`, as: registrar })
    expect(before.json().items).toHaveLength(1)

    const applied = await importFile(fileId, 'apply')
    expect(applied.counts).toMatchObject({ created: 2, exists: 1, error: 3 })
    const after = await call(fx.app, { url: `/cases?year=${year}&q=${run}`, as: registrar })
    const created = (after.json().items as Json[]).find((item) => item.index === `09-02-${run}`)
    expect(created).toMatchObject({
      title: 'Служебные записки отдела',
      retentionYears: 5,
      retentionNote: 'ст. 45',
      unit: { name: unitName },
    })
    expect(created.documentTypeIds).toHaveLength(2)
    const permanent = (after.json().items as Json[]).find((item) => item.index === `09-03-${run}`)
    expect(permanent).toMatchObject({ retentionYears: null, retentionNote: 'Хранится постоянно' })

    // Повторный импорт того же файла ничего не дублирует
    const again = await importFile(fileId, 'apply')
    expect(again.counts).toMatchObject({ created: 0, exists: 3 })
  })

  it('не книга Excel и таблица без нужных столбцов — понятный отказ', async () => {
    const text = await uploadFile(fx.app, registrar, {
      spaceId: personalSpaceId,
      name: `номенклатура-${run}.csv`,
      content: 'Индекс;Заголовок\n01-01;Дело',
    })
    const notXlsx = await call(fx.app, {
      method: 'POST',
      url: '/cases/import',
      as: registrar,
      payload: { fileId: text.id, mode: 'check' },
    })
    expect(notXlsx.statusCode).toBe(400)
    expect(notXlsx.json().detail).toContain('книгу Excel')

    const wrong = await upload([
      ['Номер', 'Описание'],
      ['1', 'Что-то'],
    ])
    const noTable = await call(fx.app, {
      method: 'POST',
      url: '/cases/import',
      as: registrar,
      payload: { fileId: wrong, mode: 'check' },
    })
    expect(noTable.statusCode).toBe(400)
    expect(noTable.json().detail).toContain('«Индекс» и «Заголовок дела»')
  })
})
