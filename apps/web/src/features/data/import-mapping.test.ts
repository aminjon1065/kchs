import type { DatasetRecord, ImportAnalysis, ImportColumn } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildRunInput,
  defaultDatasetName,
  geometryFieldKey,
  mappingProblems,
  needsCrs,
  optionsFrom,
  rowsFrom,
} from './import-mapping.js'

const column = (index: number, patch: Partial<ImportColumn>): ImportColumn => ({
  index,
  name: `Столбец ${index + 1}`,
  key: `column_${index + 1}`,
  type: 'text',
  semantic: 'dimension',
  emptyShare: 0,
  unique: false,
  invalid: 0,
  samples: [],
  ...patch,
})

const analysis = (patch: Partial<ImportAnalysis> = {}): ImportAnalysis => ({
  format: 'csv',
  encoding: 'windows-1251',
  delimiter: ';',
  decimal: ',',
  thousands: ' ',
  dateOrder: 'dmy',
  sheets: [],
  sheet: null,
  skipRows: 0,
  headerRows: 1,
  rowEstimate: 120,
  approx: false,
  columns: [
    column(0, {
      name: 'Код',
      key: 'kod',
      type: 'identifier',
      semantic: 'identifier',
      unique: true,
    }),
    column(1, { name: 'Район', key: 'rayon' }),
    column(2, { name: 'Ущерб', key: 'ushcherb', type: 'money', semantic: 'measure' }),
    column(3, { name: 'Пусто', key: 'pusto', emptyShare: 1 }),
  ],
  preview: [],
  geometry: null,
  geo: null,
  warnings: [],
  ...patch,
})

const dataset: DatasetRecord = {
  id: '0190f5a0-0000-7000-8000-000000000001',
  name: 'Происшествия',
  description: null,
  kind: 'table',
  spaceId: '0190f5a0-0000-7000-8000-000000000002',
  parentId: null,
  fields: [
    {
      id: '0190f5a0-0000-7000-8000-000000000003',
      key: 'code',
      label: { ru: 'Код' },
      type: 'identifier',
      semantic: 'identifier',
      nullable: true,
      required: false,
      unique: true,
      indexed: true,
      sensitive: false,
      readOnly: false,
      order: 0,
    },
    {
      id: '0190f5a0-0000-7000-8000-000000000004',
      key: 'damage',
      label: { ru: 'Ущерб' },
      type: 'money',
      semantic: 'measure',
      nullable: true,
      required: false,
      unique: false,
      indexed: false,
      sensitive: false,
      readOnly: false,
      order: 1,
    },
    {
      id: '0190f5a0-0000-7000-8000-000000000005',
      key: 'location',
      label: { ru: 'Место' },
      type: 'geometry',
      semantic: 'geometry',
      nullable: true,
      required: false,
      unique: false,
      indexed: false,
      sensitive: false,
      readOnly: false,
      order: 2,
    },
  ],
  primaryKey: ['code'],
  timeField: null,
  territoryField: null,
  rowCount: 10,
  currentVersion: 3,
  schemaVersion: 1,
  lastImportAt: null,
  settings: { editable: true, trackHistory: true },
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-18T10:00:00.000Z',
}

describe('мастер импорта: сопоставление', () => {
  it('настройки чтения берутся из анализа, неподдерживаемый разделитель тысяч отбрасывается', () => {
    expect(optionsFrom(analysis())).toEqual({
      format: 'csv',
      encoding: 'windows-1251',
      delimiter: ';',
      skipRows: 0,
      headerRows: 1,
      decimal: ',',
      thousands: ' ',
      dateOrder: 'dmy',
    })
    expect(optionsFrom(analysis({ thousands: '\u00a0' })).thousands).toBeUndefined()
  })

  it('геоформат: слой и выбранная система координат читаются так же при нормализации', () => {
    const geo = {
      crs: 'EPSG:32642',
      crsName: 'WGS 84 / UTM zone 42N',
      crsSource: 'option' as const,
      geometryType: 'Point',
      layers: [
        { name: 'pvr', rows: 3, geometryType: 'Point' },
        { name: 'roads', rows: 1, geometryType: 'LineString' },
      ],
      layer: 'pvr',
      fixed: 0,
      invalid: 0,
      bbox: [67.1, 38.5, 67.2, 38.6],
    }
    const shp = analysis({ format: 'shp', geometry: { kind: 'features' }, geo })
    expect(optionsFrom(shp)).toMatchObject({ format: 'shp', layer: 'pvr', crs: 'EPSG:32642' })
    expect(needsCrs(shp)).toBe(false)
    // Система координат из файла не передаётся: движок прочтёт её сам
    expect(optionsFrom(analysis({ geo: { ...geo, crsSource: 'file' } })).crs).toBeUndefined()

    const unknown = { ...geo, crs: null, crsName: null, crsSource: 'unknown' as const }
    expect(
      needsCrs(analysis({ format: 'shp', geometry: { kind: 'features' }, geo: unknown })),
    ).toBe(true)
    // x/y в метрах без собранной геометрии: можно загрузить и без неё
    expect(needsCrs(analysis({ geo: unknown }))).toBe(false)
  })

  it('новый датасет: предложения движка, полностью пустой столбец не загружается', () => {
    const rows = rowsFrom(analysis())
    expect(rows.map((row) => [row.fieldKey, row.type, row.include])).toEqual([
      ['kod', 'identifier', true],
      ['rayon', 'text', true],
      ['ushcherb', 'money', true],
      ['pusto', 'text', false],
    ])
    expect(rows[0]?.label).toBe('Код')
  })

  it('существующий датасет: столбцы находят поля по подписи; геометрия и повторы не сопоставляются', () => {
    const rows = rowsFrom(
      analysis({
        columns: [
          column(0, { name: 'код', key: 'kod' }),
          column(1, { name: 'Ущерб', key: 'ushcherb' }),
          column(2, { name: 'Ущерб', key: 'ushcherb_2' }),
          column(3, { name: 'Место', key: 'mesto' }),
        ],
      }),
      dataset,
    )
    expect(rows.map((row) => [row.fieldKey, row.type, row.include])).toEqual([
      ['code', 'identifier', true],
      ['damage', 'money', true],
      ['', 'text', false],
      ['', 'text', false],
    ])
  })

  it('проверки: ключи полей, повторы, имя, ключ для upsert', () => {
    const rows = rowsFrom(analysis())
    expect(mappingProblems(rows, { name: 'Сводка', mode: 'replace' })).toEqual([])
    expect(mappingProblems(rows, { name: ' ', mode: 'replace' })).toEqual([{ code: 'name' }])

    const broken = rows.map((row, index) =>
      index === 1 ? { ...row, fieldKey: 'kod' } : index === 2 ? { ...row, fieldKey: 'Сумма' } : row,
    )
    expect(mappingProblems(broken, { name: 'Сводка', mode: 'replace' })).toEqual([
      { code: 'duplicate', key: 'kod' },
      { code: 'keyFormat' },
    ])
    expect(
      mappingProblems(
        rows.map((row) => ({ ...row, include: false })),
        { name: 'Сводка', mode: 'replace' },
      ),
    ).toEqual([{ code: 'none' }])

    const existingRows = rowsFrom(
      analysis({ columns: [column(0, { name: 'Ущерб', key: 'ushcherb' })] }),
      dataset,
    )
    // Для upsert ключ датасета (code) должен быть в файле
    expect(mappingProblems(existingRows, { dataset, name: '', mode: 'upsert' })).toEqual([
      { code: 'keyRequired' },
    ])
    expect(mappingProblems(existingRows, { dataset, name: '', mode: 'append' })).toEqual([])
  })

  it('запрос запуска: новый датасет с ключом и геометрией, поле геометрии не совпадает со столбцами', () => {
    const rows = rowsFrom(analysis()).map((row) =>
      row.fieldKey === 'rayon' ? { ...row, fieldKey: 'geometry' } : row,
    )
    rows[0] = { ...(rows[0] as (typeof rows)[number]), key: true }
    expect(geometryFieldKey(rows)).toBe('geometry_2')

    const input = buildRunInput({
      fileId: '0190f5a0-0000-7000-8000-00000000000f',
      options: optionsFrom(analysis()),
      rows,
      target: { name: '  Сводка  ', mode: 'replace', spaceId: dataset.spaceId },
      geometry: { kind: 'latlon', lat: 4, lon: 5 },
      onError: 'skip',
    })
    expect(input.target).toEqual({ kind: 'new', name: 'Сводка', spaceId: dataset.spaceId })
    expect(input.key).toEqual(['kod'])
    expect(input.mapping.map((item) => item.fieldKey)).toEqual(['kod', 'geometry', 'ushcherb'])
    expect(input.geometryField).toBe('geometry_2')
    // Предпросмотр изменений — только при обновлении существующего датасета по ключу
    expect(input.review).toBe(false)
  })

  it('запрос запуска: существующий датасет — его ключ и его поле геометрии', () => {
    const rows = rowsFrom(
      analysis({
        columns: [column(0, { name: 'Код', key: 'kod' }), column(1, { name: 'Ущерб', key: 'u' })],
      }),
      dataset,
    )
    const input = buildRunInput({
      fileId: '0190f5a0-0000-7000-8000-00000000000f',
      options: {},
      rows,
      target: { dataset, name: '', mode: 'upsert', spaceId: dataset.spaceId },
      geometry: { kind: 'wkt', column: 2 },
      onError: 'stop',
      review: true,
    })
    expect(input.target).toEqual({ kind: 'existing', datasetId: dataset.id, mode: 'upsert' })
    expect(input.key).toEqual(['code'])
    expect(input.geometryField).toBe('location')
    expect(input.onError).toBe('stop')
    expect(input.review).toBe(true)
    const append = buildRunInput({
      fileId: '0190f5a0-0000-7000-8000-00000000000f',
      options: {},
      rows,
      target: { dataset, name: '', mode: 'append', spaceId: dataset.spaceId },
      geometry: null,
      onError: 'skip',
      review: true,
    })
    expect(append.review).toBe(false)
  })

  it('имя датасета по умолчанию — имя файла без расширения', () => {
    expect(defaultDatasetName('Сводка ЧС 2026.xlsx')).toBe('Сводка ЧС 2026')
    expect(defaultDatasetName('.csv')).toBe('.csv')
  })
})
