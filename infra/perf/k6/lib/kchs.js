// Общие части нагрузочных профилей масштаба S2 (15-admin-operations.md §3,
// 04-verification.md §4). Профили api-basic, data-queries и gis-tiles — профили
// стенда S1 — самодостаточны и этот модуль не используют: их бюджеты и код
// менять нельзя.
//
// Адрес установки — KCHS_PERF_API; профили одинаково работают против стенда
// разработки, установки в контейнерах и кластера:
//   KCHS_PERF_API=https://kchs.example.org/api/v1
import { check, fail } from 'k6'
import http from 'k6/http'

export const API = (__ENV.KCHS_PERF_API || 'http://host.docker.internal:3000/api/v1').replace(
  /\/$/,
  '',
)
export const COOKIE = __ENV.KCHS_PERF_COOKIE || 'kchs_session'
export const ADMIN = __ENV.KCHS_PERF_ADMIN || 'admin'
export const ADMIN_PASSWORD = __ENV.KCHS_PERF_ADMIN_PASSWORD || 'Kchs!Start-2026-7q'
export const USER_PASSWORD = __ENV.KCHS_PERF_USER_PASSWORD || 'Kchs!Work-2026-3v'
/** Сотрудников в демо-данных (user001…user060, 04-verification.md §7). */
export const SEED_USERS = 60
/** Самоподписанный сертификат стенда кластера: `KCHS_PERF_INSECURE_TLS=1`. */
export const INSECURE_TLS = bool('KCHS_PERF_INSECURE_TLS', false)

/** Период демо-данных «Происшествий» (ADR-0054): 2024-01-01 … 2026-08-31. */
export const PERIOD_START = Date.UTC(2024, 0, 1)
export const PERIOD_DAYS = 974

export function num(name, fallback) {
  const raw = __ENV[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`${name}: не число — ${raw}`)
  return value
}

export function bool(name, fallback) {
  const raw = __ENV[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

export function text(name, fallback) {
  const raw = __ENV[name]
  return raw === undefined || raw === '' ? fallback : raw
}

export const pad = (n) => String(n).padStart(3, '0')
export const pick = (items) => items[Math.floor(Math.random() * items.length)]

/** Случайный день периода демо-данных, ISO-дата. */
export function randomDay(spanDays = 0) {
  const days = Math.floor(Math.random() * (PERIOD_DAYS - spanDays))
  return new Date(PERIOD_START + days * 86_400_000).toISOString().slice(0, 10)
}

export function addDays(day, count) {
  return new Date(Date.parse(day) + count * 86_400_000).toISOString().slice(0, 10)
}

export function signIn(login, password, tags = { op: 'setup' }) {
  const res = http.post(`${API}/auth/login`, JSON.stringify({ login, password }), {
    headers: { 'content-type': 'application/json' },
    tags,
  })
  const token = res.cookies[COOKIE]?.[0]?.value
  const csrf = res.status === 200 ? res.json('csrfToken') : null
  if (!token || !csrf) fail(`вход ${login}: ${res.status} ${res.body}`)
  return { token, csrf }
}

export function headers(session, json = true) {
  const result = { cookie: `${COOKIE}=${session.token}`, 'x-csrf-token': session.csrf }
  if (json) result['content-type'] = 'application/json'
  return result
}

/** Запрос с отметкой операции: по ней считаются бюджеты p95. */
export function call(session, method, path, body, op, timeout = '60s') {
  const res = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers: headers(session, body !== undefined), tags: { op }, timeout },
  )
  check(res, { [`${op}: 2xx`]: (r) => r.status >= 200 && r.status < 300 })
  return res
}

/** Тот же запрос, но ошибка останавливает профиль: подготовка обязана удаться. */
export function must(session, method, path, body) {
  const res = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers: headers(session, body !== undefined), tags: { op: 'setup' }, timeout: '120s' },
  )
  if (res.status < 200 || res.status >= 300) fail(`${method} ${path}: ${res.status} ${res.body}`)
  return res
}

/**
 * Стадии нагрузки: разгон, плато, спад. Бюджеты считаются по всему прогону, но
 * разгон короткий — на кэши и пулы соединений он влияет меньше плато.
 */
export function rampingStages(rate, duration, rampUp = '1m', rampDown = '30s') {
  return [
    { target: Math.max(1, Math.round(rate / 4)), duration: rampUp },
    { target: rate, duration },
    { target: 0, duration: rampDown },
  ]
}

/** Пороговые выражения для набора операций: {операция: 'p(95)<200'}. */
export function budgets(map) {
  const result = {}
  for (const [op, budget] of Object.entries(map)) {
    result[`http_req_duration{op:${op}}`] = [budget]
  }
  return result
}

/**
 * Итог — таблица p95 по операциям; полный отчёт k6 в JSON, если задан
 * KCHS_PERF_OUT (его задаёт infra/perf/run-k6.sh).
 */
export function summary(title, data) {
  const rows = []
  for (const [name, metric] of Object.entries(data.metrics)) {
    const match = /^http_req_duration\{op:(.+)\}$/.exec(name)
    if (!match) continue
    if (match[1] === 'setup') continue
    const failed = Object.values(metric.thresholds ?? {}).some((t) => !t.ok)
    const v = metric.values
    rows.push(
      `${match[1].padEnd(16)} ${String(v.count).padStart(6)} ${v.med.toFixed(1).padStart(8)} ` +
        `${v['p(95)'].toFixed(1).padStart(8)} ${v.max.toFixed(1).padStart(8)}  ` +
        `${failed ? 'ВНЕ БЮДЖЕТА' : 'в бюджете'}`,
    )
  }
  const failedRate = data.metrics.http_req_failed?.values.rate ?? 0
  const text = [
    '',
    `k6: ${API}, ${title}`,
    `${'операция'.padEnd(16)} ${'запросов'.padStart(6)} ${'медиана'.padStart(8)} ` +
      `${'p95, мс'.padStart(8)} ${'макс'.padStart(8)}`,
    ...rows.sort(),
    `ошибки HTTP: ${(failedRate * 100).toFixed(2)} %`,
    '',
  ].join('\n')
  const out = { stdout: text }
  if (__ENV.KCHS_PERF_OUT) out[__ENV.KCHS_PERF_OUT] = JSON.stringify(data, null, 2)
  return out
}
