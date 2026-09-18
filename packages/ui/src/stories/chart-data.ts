import { ChartSpec, type QueryResult, type QueryResultField } from '@kchs/contracts'

/**
 * Данные историй графиков: происшествия и паводковая обстановка по регионам
 * и районам Таджикистана. Значения фиксированы — снимки не зависят от даты.
 */
type FieldSpec = Pick<QueryResultField, 'name' | 'type'> & Partial<QueryResultField>

export function queryResult(fields: FieldSpec[], rows: unknown[][]): QueryResult {
  return {
    fields: fields.map((f) => ({ semantic: null, label: null, format: null, ...f })),
    rows,
    rowCount: rows.length,
    approx: false,
    truncated: false,
    durationMs: 12,
    cached: false,
  }
}

export function chartSpec(input: Record<string, unknown>): ChartSpec {
  return ChartSpec.parse({
    version: 1,
    data: { queryId: '01928c4e-7a3b-7c3d-9e4f-0a1b2c3d4e5f' },
    encoding: {},
    ...input,
  })
}

const MONTHS = [
  '2026-01-01',
  '2026-02-01',
  '2026-03-01',
  '2026-04-01',
  '2026-05-01',
  '2026-06-01',
  '2026-07-01',
  '2026-08-01',
  '2026-09-01',
]

export const REGIONS = ['Хатлон', 'Согд', 'РРП', 'ГБАО', 'Душанбе']

/** Происшествия по месяцам и регионам. */
export const BY_MONTH_REGION = queryResult(
  [
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц', en: 'Month' } },
    { name: 'region', type: 'text', semantic: 'dimension', label: { ru: 'Регион', en: 'Region' } },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
  ],
  MONTHS.flatMap((month, i) => [
    [month, 'Хатлон', [34, 31, 48, 62, 71, 55, 41, 38, 36][i]],
    [month, 'Согд', [22, 25, 30, 44, 52, 47, 33, 29, 27][i]],
    [month, 'РРП', [18, 16, 27, 39, 45, 36, 24, 21, 19][i]],
  ]),
)

/** Итог по месяцам (один ряд). */
export const BY_MONTH = queryResult(
  [
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц', en: 'Month' } },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
  ],
  MONTHS.map((month, i) => [month, [74, 72, 105, 145, 168, 138, 98, 88, 82][i]]),
)

/** Происшествия и ущерб по районам. */
export const BY_DISTRICT = queryResult(
  [
    {
      name: 'district',
      type: 'text',
      semantic: 'dimension',
      label: { ru: 'Район', en: 'District' },
    },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
    {
      name: 'damage',
      type: 'decimal',
      semantic: 'measure',
      label: { ru: 'Ущерб, тыс. сомони', en: 'Damage, thousand TJS' },
      format: { precision: 0 },
    },
  ],
  [
    ['Рудаки', 42, 1240],
    ['Варзоб', 31, 5870],
    ['Вахдат', 28, 930],
    ['Рашт', 21, 3400],
    ['Турсунзаде', 17, 2210],
    ['Гиссар', 12, 410],
    ['Нурабад', 9, 260],
    ['Файзабад', 7, 120],
    ['Таджикабад', 5, 95],
    ['Шахринав', 3, 80],
  ],
)

/** Виды происшествий — доли целого. */
export const BY_KIND = queryResult(
  [
    { name: 'kind', type: 'text', semantic: 'category', label: { ru: 'Вид', en: 'Kind' } },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
  ],
  [
    ['Паводок', 184],
    ['Сель', 131],
    ['Оползень', 76],
    ['Лавина', 38],
    ['Землетрясение', 22],
  ],
)

/** Посты наблюдения: уровень воды и расход — точечная и пузырьковая. */
export const GAUGES = queryResult(
  [
    { name: 'post', type: 'text', semantic: 'identifier', label: { ru: 'Пост', en: 'Post' } },
    { name: 'river', type: 'text', semantic: 'dimension', label: { ru: 'Река', en: 'River' } },
    {
      name: 'level',
      type: 'decimal',
      semantic: 'measure',
      label: { ru: 'Уровень, см', en: 'Level, cm' },
    },
    {
      name: 'flow',
      type: 'decimal',
      semantic: 'measure',
      label: { ru: 'Расход, м³/с', en: 'Flow, m³/s' },
    },
    {
      name: 'population',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Население в зоне, чел.', en: 'Population at risk' },
    },
  ],
  [
    ['Пяндж — Нижний', 'Пяндж', 412, 1180, 42000],
    ['Пяндж — Хорог', 'Пяндж', 356, 940, 18000],
    ['Пяндж — Калаи-Хумб', 'Пяндж', 298, 820, 9000],
    ['Вахш — Гарм', 'Вахш', 268, 610, 12000],
    ['Вахш — Нурек', 'Вахш', 305, 720, 26000],
    ['Вахш — Кургантюбе', 'Вахш', 341, 830, 51000],
    ['Варзоб — Варзоб', 'Варзоб', 142, 96, 8000],
    ['Варзоб — Душанбе', 'Варзоб', 175, 128, 64000],
    ['Кафирниган — Файзабад', 'Кафирниган', 188, 164, 11000],
    ['Кафирниган — Тартки', 'Кафирниган', 214, 206, 23000],
    ['Зеравшан — Айни', 'Зеравшан', 226, 188, 7000],
    ['Сырдарья — Худжанд', 'Сырдарья', 251, 512, 58000],
  ],
)

/** Происшествия по районам и месяцам — тепловая карта. */
export const DISTRICT_MONTH = queryResult(
  [
    {
      name: 'district',
      type: 'text',
      semantic: 'dimension',
      label: { ru: 'Район', en: 'District' },
    },
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц', en: 'Month' } },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
  ],
  ['Рудаки', 'Варзоб', 'Вахдат', 'Рашт', 'Турсунзаде', 'Гиссар'].flatMap((district, d) =>
    MONTHS.slice(0, 6).map((month, m) => [district, month, ((d + 2) * (m + 3) * 7) % 23]),
  ),
)

/** Время прибытия расчётов, мин — гистограмма. */
export const ARRIVAL = queryResult(
  [
    {
      name: 'minutes',
      type: 'number',
      semantic: 'measure',
      label: { ru: 'Время прибытия, мин', en: 'Arrival time, min' },
    },
  ],
  Array.from({ length: 240 }, (_, i) => [
    Math.round(12 + 9 * Math.sin(i * 1.7) + 7 * Math.cos(i * 0.37) + (i % 11) * 1.4),
  ]),
)

/** Этапы обработки сообщений — воронка. */
export const PIPELINE = queryResult(
  [
    { name: 'stage', type: 'text', semantic: 'category', label: { ru: 'Этап', en: 'Stage' } },
    {
      name: 'count',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Сообщения', en: 'Reports' },
    },
  ],
  [
    ['Поступило', 1240],
    ['Проверено', 1012],
    ['Требует выезда', 486],
    ['Расчёт на месте', 451],
    ['Закрыто', 402],
  ],
)

/** Готовность техники, % — шкала. */
export const READINESS = queryResult(
  [
    {
      name: 'ready',
      type: 'number',
      semantic: 'measure',
      label: { ru: 'Готовность техники, %', en: 'Equipment readiness, %' },
    },
  ],
  [[78]],
)

/** Ущерб по регионам и районам — древовидная карта. */
export const DAMAGE_TREE = queryResult(
  [
    { name: 'region', type: 'text', semantic: 'dimension', label: { ru: 'Регион', en: 'Region' } },
    {
      name: 'district',
      type: 'text',
      semantic: 'dimension',
      label: { ru: 'Район', en: 'District' },
    },
    {
      name: 'damage',
      type: 'decimal',
      semantic: 'measure',
      label: { ru: 'Ущерб, тыс. сомони', en: 'Damage, thousand TJS' },
      format: { precision: 0 },
    },
  ],
  [
    ['РРП', 'Варзоб', 5870],
    ['РРП', 'Рудаки', 1240],
    ['РРП', 'Вахдат', 930],
    ['РРП', 'Рашт', 3400],
    ['Хатлон', 'Кулоб', 2860],
    ['Хатлон', 'Бохтар', 2140],
    ['Хатлон', 'Дангара', 760],
    ['Согд', 'Худжанд', 1980],
    ['Согд', 'Истаравшан', 640],
    ['ГБАО', 'Хорог', 1520],
    ['ГБАО', 'Ишкашим', 410],
  ],
)

/** Итоги месяца — плитки показателей. */
export const KPI = queryResult(
  [
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц', en: 'Month' } },
    {
      name: 'incidents',
      type: 'integer',
      semantic: 'measure',
      label: { ru: 'Происшествия', en: 'Incidents' },
    },
    {
      name: 'response',
      type: 'number',
      semantic: 'measure',
      label: { ru: 'Время реагирования, мин', en: 'Response time, min' },
      format: { precision: 1 },
    },
    {
      name: 'damage',
      type: 'decimal',
      semantic: 'measure',
      label: { ru: 'Ущерб, сомони', en: 'Damage, TJS' },
      format: { precision: 0 },
    },
  ],
  MONTHS.map((month, i) => [
    month,
    [74, 72, 105, 145, 168, 138, 98, 88, 82][i],
    [21.4, 20.8, 19.6, 18.2, 17.9, 18.4, 17.1, 16.6, 16.9][i],
    [
      1_840_000, 1_620_000, 3_950_000, 6_120_000, 8_430_000, 5_210_000, 2_870_000, 2_150_000,
      1_960_000,
    ][i],
  ]),
)
