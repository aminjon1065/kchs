import type { APIRequestContext } from '@playwright/test'
import { expect } from './fixtures.js'

/**
 * Данные сценариев отчётов (ADR-0078) — по API: датасет происшествий с датой,
 * районом, ущербом и точкой, графики, показатель, слой и карта. Отчёт
 * печатает движок, поэтому всё — в пространстве администратора.
 */

const DISTRICTS = ['Хатлон', 'Согд', 'ГБАО', 'Душанбе', 'РРП']
const KINDS = ['Паводок', 'Сель', 'Оползень', 'Пожар']

export interface ReportData {
  headers: Record<string, string>
  spaceId: string
  datasetId: string
  datasetName: string
  chartIds: string[]
  metricId: string
  layerId: string
  mapId: string
  mapName: string
}

export async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), 'сессия действительна').toBeTruthy()
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

async function post<T>(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  data: unknown,
): Promise<T> {
  const response = await request.post(url, { headers, data })
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBeTruthy()
  return (await response.json()) as T
}

/** Датасет, строки, графики (столбцы по районам и линия по месяцам), показатель, слой и карта. */
export async function createReportData(
  request: APIRequestContext,
  run: string,
  options: { rows: number; charts: number },
): Promise<ReportData> {
  const headers = await csrfHeaders(request)
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
  const datasetName = `Происшествия отчёта ${run}`
  const { id: datasetId } = await post<{ id: string }>(request, '/api/v1/datasets', headers, {
    name: datasetName,
    spaceId,
    fields: [
      { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
      { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
      { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
      { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
      { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
      { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
    ],
  })
  const today = new Date()
  const rows = Array.from({ length: options.rows }, (_, index) => {
    const day = new Date(today.getTime() - (index % 150) * 86_400_000)
    return {
      values: {
        code: `R-${run}-${index + 1}`,
        district: DISTRICTS[index % DISTRICTS.length],
        kind: KINDS[index % KINDS.length],
        day: day.toISOString().slice(0, 10),
        damage: 1000 + ((index * 7919) % 50_000),
        place: {
          type: 'Point',
          coordinates: [68 + ((index * 37) % 500) / 100, 37.2 + ((index * 53) % 300) / 100],
        },
      },
    }
  })
  for (let start = 0; start < rows.length; start += 500) {
    await post(request, `/api/v1/datasets/${datasetId}/rows`, headers, {
      rows: rows.slice(start, start + 500),
    })
  }

  const chartIds: string[] = []
  for (let index = 0; index < options.charts; index++) {
    const byMonth = index % 2 === 1
    const { id } = await post<{ id: string }>(request, '/api/v1/charts', headers, {
      name: byMonth
        ? `Происшествия по месяцам ${run} ${index + 1}`
        : `Происшествия по районам ${run} ${index + 1}`,
      spaceId,
      spec: {
        version: 1,
        type: byMonth ? 'line' : 'bar',
        data: {
          query: {
            version: 1,
            source: { kind: 'dataset', id: datasetId },
            steps: [
              {
                type: 'aggregate',
                groupBy: [
                  byMonth
                    ? { field: 'day', bucket: 'month', alias: 'month' }
                    : { field: 'district' },
                ],
                measures: [{ alias: 'n', agg: 'count' }],
              },
            ],
          },
        },
        encoding: {
          x: byMonth
            ? { field: 'month', type: 'temporal', label: { ru: 'Месяц' } }
            : { field: 'district', type: 'nominal', label: { ru: 'Район' } },
          y: [{ field: 'n', type: 'quantitative', label: { ru: 'Происшествий' } }],
        },
      },
    })
    chartIds.push(id)
  }

  const { id: metricId } = await post<{ id: string }>(request, '/api/v1/metrics', headers, {
    name: `Число происшествий ${run}`,
    spaceId,
    datasetId,
    definition: { measure: { agg: 'count' }, period: null },
  })
  const { id: layerId } = await post<{ id: string }>(request, '/api/v1/gis/layers', headers, {
    name: `Происшествия на карте ${run}`,
    spaceId,
    datasetId,
  })
  const mapName = `Карта происшествий ${run}`
  const { id: mapId } = await post<{ id: string }>(request, '/api/v1/gis/maps', headers, {
    name: mapName,
    spaceId,
    spec: {
      layers: [{ layerId, visible: true, opacity: 1, group: null }],
      camera: { center: [70.8, 38.7], zoom: 5.6, bearing: 0, pitch: 0 },
    },
  })
  return {
    headers,
    spaceId,
    datasetId,
    datasetName,
    chartIds,
    metricId,
    layerId,
    mapId,
    mapName,
  }
}

/** Число страниц PDF Chromium — объекты `/Type /Page`. */
export function pdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}
