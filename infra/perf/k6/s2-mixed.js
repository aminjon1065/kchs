// Совмещённый профиль масштаба S2: рабочий день, чаты, тайлы и тяжёлые запросы
// к датасетам одновременно — так установка живёт на самом деле. Отдельные
// профили (s2-workday, s2-tiles, s2-analytics) меряют часть в чистом виде, этот
// показывает, держатся ли бюджеты, когда части конкурируют за Postgres, Redis,
// движок и пул соединений.
//
// Бюджеты — те же, что у частей (04-verification.md §4): базовые операции
// p95 ≤ 200 мс, поиск ≤ 100 мс, тайлы ≤ 50/300 мс, запрос к датасету ≤ 2 с.
// Доли нагрузки по умолчанию — половина от одиночных профилей: совмещённый
// прогон нагружает установку сильнее каждого из них.
//
// Запуск — KCHS_PERF_PROFILE=s2-mixed bash infra/perf/run-k6.sh
//   KCHS_PERF_CONCURRENT=1000  одновременных сотрудников
//   KCHS_PERF_TILE_RATE=200    тайлов в секунду
//   KCHS_PERF_QUERY_RATE=5     тяжёлых запросов в секунду
//   KCHS_PERF_DURATION=15m     плато нагрузки
import {
  ADMIN,
  ADMIN_PASSWORD,
  budgets,
  INSECURE_TLS,
  num,
  rampingStages,
  signIn,
  summary,
  text,
} from './lib/kchs.js'
import { prepareAnalytics, query } from './s2-analytics.js'
import { cached, cold, prepareTiles } from './s2-tiles.js'
import { chat, login, prepareWorkday, workday } from './s2-workday.js'

const CONCURRENT = num('KCHS_PERF_CONCURRENT', 1000)
const RATE = num('KCHS_PERF_RATE', Math.max(1, Math.round(CONCURRENT / 60)))
const CHAT_RATE = num('KCHS_PERF_CHAT_RATE', Math.max(1, Math.round(RATE / 2)))
const TILE_RATE = num('KCHS_PERF_TILE_RATE', 200)
const COLD_SHARE = num('KCHS_PERF_COLD_SHARE', 0.2)
const COLD_RATE = Math.max(1, Math.round(TILE_RATE * COLD_SHARE))
const CACHED_RATE = Math.max(1, TILE_RATE - COLD_RATE)
const QUERY_RATE = num('KCHS_PERF_QUERY_RATE', 5)
const DURATION = text('KCHS_PERF_DURATION', '10m')

const BASE_OPS = [
  'me',
  'inbox',
  'inbox_counts',
  'notifications',
  'objects_list',
  'object',
  'tasks_summary',
  'chat_list',
  'chat_messages',
  'chat_post',
  'chat_read',
]
const QUERY_OPS = ['agg_region', 'agg_month', 'agg_period', 'rows_page', 'drill', 'profile']

const arrival = (fn, rate) => ({
  executor: 'ramping-arrival-rate',
  exec: fn,
  startRate: 1,
  timeUnit: '1s',
  preAllocatedVUs: Math.max(4, rate * 2),
  maxVUs: Math.max(16, rate * 8),
  stages: rampingStages(rate, DURATION),
})

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    workday: arrival('workday', RATE),
    chat: arrival('chat', CHAT_RATE),
    tilesCold: arrival('cold', COLD_RATE),
    tilesCached: arrival('cached', CACHED_RATE),
    queries: arrival('query', QUERY_RATE),
    login: {
      executor: 'constant-arrival-rate',
      exec: 'login',
      rate: 1,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 4,
      maxVUs: 10,
    },
  },
  thresholds: {
    ...budgets(Object.fromEntries(BASE_OPS.map((op) => [op, 'p(95)<200']))),
    ...budgets({ search: 'p(95)<100', chat_search: 'p(95)<100' }),
    ...budgets({ tile_cold: 'p(95)<300', tile_cached: 'p(95)<50' }),
    ...budgets(Object.fromEntries(QUERY_OPS.map((op) => [op, 'p(95)<2000']))),
    ...budgets({ login: `p(95)<${num('KCHS_PERF_LOGIN_BUDGET_MS', 500)}` }),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  // Подготовка трёх частей: пространство с папками и каналом, слой и прогрев
  // тайлов, поиск демо-датасета
  setupTimeout: '600s',
}

export function setup() {
  const admin = signIn(ADMIN, ADMIN_PASSWORD)
  return {
    workday: prepareWorkday(admin),
    tiles: prepareTiles(admin),
    analytics: prepareAnalytics(admin),
  }
}

export { cached, chat, cold, login, query, workday }

export function handleSummary(data) {
  return summary(
    `совмещённый S2: ${RATE} цикл/с, ${CHAT_RATE} беседы/с, ${TILE_RATE} тайлов/с, ` +
      `${QUERY_RATE} запрос/с, ${DURATION}`,
    data,
  )
}
