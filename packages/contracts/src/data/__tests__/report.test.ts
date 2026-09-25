import { describe, expect, it } from 'vitest'
import { NotebookCell } from '../notebook.js'
import {
  notebookCellsToBlocks,
  REPORT_BLOCK_KINDS,
  REPORT_BLOCK_LAYOUT,
  ReportBlock,
  ReportScheduleInput,
  reportBlockReferences,
  reportCronPattern,
} from '../report.js'

const DATASET = '01890000-0000-7000-8000-000000000001'
const CHART = '01890000-0000-7000-8000-000000000002'
const METRIC = '01890000-0000-7000-8000-000000000003'
const MAP = '01890000-0000-7000-8000-000000000004'
const LAYER = '01890000-0000-7000-8000-000000000005'

describe('расписание отчёта → cron', () => {
  const base = { time: '08:05', weekdays: [1], monthDay: 1, cron: null }

  it('ежедневно, еженедельно (воскресенье — 0), ежемесячно', () => {
    expect(reportCronPattern({ ...base, frequency: 'daily' })).toBe('5 8 * * *')
    expect(reportCronPattern({ ...base, frequency: 'weekly', weekdays: [7, 1, 3, 1] })).toBe(
      '5 8 * * 0,1,3',
    )
    expect(reportCronPattern({ ...base, frequency: 'monthly', monthDay: 28 })).toBe('5 8 28 * *')
  })

  it('своё выражение — как есть, без лишних пробелов', () => {
    expect(reportCronPattern({ ...base, frequency: 'cron', cron: ' 0  9 1 *  * ' })).toBe(
      '0 9 1 * *',
    )
  })

  it('ввод расписания: время ЧЧ:ММ, день месяца до 28-го, получатели любого вида, канал', () => {
    const valid = {
      frequency: 'weekly',
      timezone: 'Asia/Dushanbe',
      recipients: [DATASET],
      channels: ['telegram'],
    }
    expect(ReportScheduleInput.parse(valid)).toMatchObject({
      enabled: true,
      time: '08:00',
      formats: ['pdf'],
      params: null,
    })
    expect(ReportScheduleInput.safeParse({ ...valid, time: '24:00' }).success).toBe(false)
    expect(ReportScheduleInput.safeParse({ ...valid, monthDay: 31 }).success).toBe(false)
    // Получатели — сотрудники, группы, роли или внешние адреса (ADR-0164); что указан хоть
    // кто-то, проверяет сервис при сохранении
    expect(
      ReportScheduleInput.parse({ ...valid, recipients: [], roles: ['registrar'] }),
    ).toMatchObject({ recipients: [], groups: [], roles: ['registrar'], emails: [] })
    expect(ReportScheduleInput.safeParse({ ...valid, emails: ['не-адрес'] }).success).toBe(false)
    expect(ReportScheduleInput.safeParse({ ...valid, channels: [] }).success).toBe(false)
  })
})

describe('тетрадь → отчёт', () => {
  it('ячейки становятся блоками: ИИ-ответ — запросом со своим заголовком, SQL — таблицей', () => {
    const cells = [
      {
        id: 'intro',
        kind: 'text',
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
      { id: 'q', kind: 'query', datasetId: DATASET, view: 'chart', chartType: 'bar' },
      { id: 'sql', kind: 'query', mode: 'sql', sql: 'select 1', view: 'chart' },
      {
        id: 'ai',
        kind: 'ai',
        datasetId: DATASET,
        question: 'сколько?',
        answer: { title: 'Ответ ИИ', explanation: '…' },
      },
      { id: 'c', kind: 'chart', chartId: CHART, bindings: { period: null } },
      { id: 'm', kind: 'metric', metricId: METRIC },
      { id: 'empty', kind: 'metric', metricId: null },
      { id: 'map', kind: 'map', mapId: MAP },
    ].map((cell) => NotebookCell.parse(cell))
    const blocks = notebookCellsToBlocks(cells)
    expect(blocks.map((block) => [block.id, block.kind])).toEqual([
      ['intro', 'text'],
      ['q', 'query'],
      ['sql', 'query'],
      ['ai', 'query'],
      ['c', 'chart'],
      ['m', 'metrics'],
      ['empty', 'metrics'],
      ['map', 'map'],
    ])
    expect(blocks[1]).toMatchObject({ view: 'chart', chartType: 'bar', datasetId: DATASET })
    expect(blocks[2]).toMatchObject({ mode: 'sql', sql: 'select 1', view: 'table' })
    expect(blocks[3]).toMatchObject({ title: 'Ответ ИИ', mode: 'visual' })
    expect(blocks[4]).toMatchObject({ chartId: CHART, bindings: { period: null } })
    expect(blocks[5]).toMatchObject({ metricIds: [METRIC] })
    expect(blocks[6]).toMatchObject({ metricIds: [] })
    expect(blocks[7]).toMatchObject({ source: 'map', mapId: MAP, camera: null })
  })

  it('ссылки блоков — зависимости отчёта: карта или слой по источнику', () => {
    const blocks = [
      { id: 'q', kind: 'query', datasetId: DATASET },
      { id: 'c', kind: 'chart', chartId: CHART },
      { id: 'm', kind: 'metrics', metricIds: [METRIC, METRIC] },
      { id: 'map', kind: 'map', source: 'map', mapId: MAP, layerId: LAYER },
      { id: 'layer', kind: 'map', source: 'layer', mapId: null, layerId: LAYER },
    ].map((block) => ReportBlock.parse(block))
    expect(reportBlockReferences(blocks).sort()).toEqual(
      [DATASET, CHART, METRIC, MAP, LAYER].sort(),
    )
  })

  it('раскладка документа Yjs — у каждого вида, ключи совпадают со схемой блока', () => {
    for (const kind of REPORT_BLOCK_KINDS) {
      const block = ReportBlock.parse({ id: 'x', kind }) as Record<string, unknown>
      expect(Object.keys(REPORT_BLOCK_LAYOUT[kind]).sort()).toEqual(Object.keys(block).sort())
    }
  })
})
