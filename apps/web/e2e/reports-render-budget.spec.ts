import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures.js'
import { createReportData, pdfPages } from './report-data.js'

/** Движок с Chromium (ADR-0078) и веб, доступный ему: без них сценарий пропускается. */
const ENABLED = process.env.KCHS_E2E_REPORTS === '1'
const BUDGET_MS = 60_000

/**
 * Бюджет 04-verification.md §4: «Рендер отчёта 20 страниц с 10 графиками и
 * 2 картами ≤ 60 с». Отчёт — по API: 10 графиков, 2 карты (сохранённая карта и
 * слой), сетка показателей, таблицы по 150 строк и текст; «Сформировать» PDF и
 * DOCX. Время — от постановки запуска до готовых файлов (очередь, Chromium,
 * данные, PDF, снимки графиков и карт, DOCX, загрузка в хранилище).
 */
test.describe('Отчёты: бюджет рендера', () => {
  test.skip(!ENABLED, 'нужен движок с Chromium — задайте KCHS_E2E_REPORTS=1')

  test('20+ страниц, 10 графиков, 2 карты — PDF и DOCX за 60 с', async ({ request }) => {
    test.setTimeout(240_000)
    const run = Date.now().toString(36)
    const data = await createReportData(request, run, { rows: 600, charts: 10 })
    const paragraph = (text: string) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })
    const text = (id: string, heading: string) => ({
      id,
      kind: 'text',
      body: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
          ...Array.from({ length: 4 }, (_, index) =>
            paragraph(
              `Раздел «${heading}», абзац ${index + 1}. Обстановка по районам за период: паводки, сели и оползни; меры реагирования и силы, задействованные в ликвидации последствий.`,
            ),
          ),
        ],
      },
    })
    const blocks: unknown[] = [text('intro', 'Сводка за период')]
    data.chartIds.forEach((chartId, index) => {
      blocks.push({ id: `c${index}`, kind: 'chart', chartId, size: 'medium' })
      if (index % 3 === 2) blocks.push(text(`t${index}`, `Выводы ${index + 1}`))
    })
    blocks.push({ id: 'm', kind: 'metrics', metricIds: [data.metricId] })
    blocks.push({ id: 'map1', kind: 'map', source: 'map', mapId: data.mapId, size: 'large' })
    blocks.push({ id: 'map2', kind: 'map', source: 'layer', layerId: data.layerId, size: 'large' })
    for (let index = 0; index < 4; index++) {
      blocks.push({ id: `pb${index}`, kind: 'page_break' })
      blocks.push({
        id: `q${index}`,
        kind: 'query',
        title: `Происшествия, часть ${index + 1}`,
        datasetId: data.datasetId,
        plan: {
          filter: null,
          groups: [],
          measures: [],
          sort: { field: 'code', dir: 'asc' },
          limit: null,
        },
        view: 'table',
        maxRows: 150,
      })
    }
    const created = await request.post('/api/v1/reports', {
      headers: data.headers,
      data: {
        name: `Бюджет рендера ${run}`,
        spaceId: data.spaceId,
        blocks,
        settings: { formats: ['pdf', 'docx'], footer: 'Бюджет 04-verification §4' },
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const reportId = (await created.json()).id as string

    const started = Date.now()
    const queued = await request.post(`/api/v1/reports/${reportId}/runs`, {
      headers: data.headers,
      data: { formats: ['pdf', 'docx'] },
    })
    expect(queued.ok(), await queued.text()).toBeTruthy()
    const runId = (await queued.json()).id as string
    let record: {
      status: string
      pages: number | null
      durationMs: number | null
      error: string | null
      files: Array<{ format: string; size: number }>
    } = { status: 'queued', pages: null, durationMs: null, error: null, files: [] }
    await expect
      .poll(
        async () => {
          record = await (await request.get(`/api/v1/reports/runs/${runId}`)).json()
          return record.status
        },
        { timeout: 180_000, intervals: [500] },
      )
      .toMatch(/succeeded|failed/)
    const elapsed = Date.now() - started
    expect(record.error).toBeNull()
    expect(record.status).toBe('succeeded')

    const download = async (format: 'pdf' | 'docx') => {
      const link = await request.get(`/api/v1/reports/runs/${runId}/download?format=${format}`)
      expect(link.ok(), await link.text()).toBeTruthy()
      const file = Buffer.from(await (await fetch((await link.json()).url)).arrayBuffer())
      // Файлы — в результаты прогона: их можно открыть и посмотреть глазами
      mkdirSync('test-results', { recursive: true })
      writeFileSync(`test-results/report-budget.${format}`, file)
      return file
    }
    const pdf = await download('pdf')
    const docx = await download('docx')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(docx.subarray(0, 2).toString()).toBe('PK')
    const pages = pdfPages(pdf)
    // biome-ignore lint/suspicious/noConsole: замер бюджета — в журнал прогона
    console.log(
      `рендер отчёта: ${pages} стр., PDF ${pdf.byteLength} Б, файлы ${JSON.stringify(record.files)}, ` +
        `движок ${record.durationMs} мс, от постановки до готовности ${elapsed} мс`,
    )
    expect(pages).toBeGreaterThanOrEqual(20)
    expect(record.files.map((file) => file.format)).toEqual(['pdf', 'docx'])
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS)
  })
})
