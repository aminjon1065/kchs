// Нагрузочный профиль базовых операций API — бюджеты 04-verification.md §4:
// базовые операции (объект, список 50, Входящие и остальные ниже) p95 ≤ 200 мс,
// поиск p95 ≤ 100 мс. Порог не выдержан — k6 завершается с ошибкой.
//
// Нагрузка по умолчанию — 5 рабочих циклов в секунду (≈ 50 запросов/с): столько
// дают ~300 одновременно работающих сотрудников — предел S1 (15-admin-operations.md
// §8). Каждый цикл — сотрудник userNNN из демо-данных: профиль, список 50 объектов
// пространства, карточка, Входящие, поиск, новая папка, сессия загрузки файла,
// обсуждение. Параллельно раз в 2 с — вход другого сотрудника (argon2id).
//
// Запуск — infra/perf/run-k6.sh (k6 в Docker); параметры — переменные KCHS_PERF_*.
import { check, fail } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'

const API = (__ENV.KCHS_PERF_API || 'http://host.docker.internal:3000/api/v1').replace(/\/$/, '')
const ADMIN = __ENV.KCHS_PERF_ADMIN || 'admin'
const ADMIN_PASSWORD = __ENV.KCHS_PERF_ADMIN_PASSWORD || 'Kchs!Start-2026-7q'
const USER_PASSWORD = __ENV.KCHS_PERF_USER_PASSWORD || 'Kchs!Work-2026-3v'
const COOKIE = __ENV.KCHS_PERF_COOKIE || 'kchs_session'
/** Сотрудники рабочих циклов — user001…userN; для входа — следующие десять. */
const USERS = Number(__ENV.KCHS_PERF_USERS || 20)
const RATE = Number(__ENV.KCHS_PERF_RATE || 5)
const DURATION = __ENV.KCHS_PERF_DURATION || '2m'
/** Папок в пространстве профиля заранее: «список 50» читает полную страницу. */
const FOLDERS = 60

const BASE_BUDGET = 'p(95)<200'
const SEARCH_BUDGET = 'p(95)<100'
// Вход намеренно дорог (argon2id, 17-security.md §2) и в бюджет базовых не входит
const LOGIN_BUDGET = `p(95)<${Number(__ENV.KCHS_PERF_LOGIN_BUDGET_MS || 500)}`

const BASE_OPS = [
  'me',
  'objects_list',
  'object',
  'inbox',
  'folder_create',
  'upload_session',
  'upload_abort',
  'discussion',
  'message_post',
]

export const options = {
  scenarios: {
    work: {
      executor: 'constant-arrival-rate',
      exec: 'work',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: USERS,
      maxVUs: USERS,
    },
    login: {
      executor: 'constant-arrival-rate',
      exec: 'login',
      rate: 1,
      timeUnit: '2s',
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
  },
  thresholds: {
    ...Object.fromEntries(BASE_OPS.map((op) => [`http_req_duration{op:${op}}`, [BASE_BUDGET]])),
    'http_req_duration{op:search}': [SEARCH_BUDGET],
    'http_req_duration{op:login}': [LOGIN_BUDGET],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  // Время подготовки (60 папок и участники) не входит в замер
  setupTimeout: '120s',
}

function headers(session, json = true) {
  const result = { cookie: `${COOKIE}=${session.token}`, 'x-csrf-token': session.csrf }
  if (json) result['content-type'] = 'application/json'
  return result
}

function signIn(login, password, tags = {}) {
  const res = http.post(`${API}/auth/login`, JSON.stringify({ login, password }), {
    headers: { 'content-type': 'application/json' },
    tags,
  })
  const token = res.cookies[COOKIE]?.[0]?.value
  const csrf = res.status === 200 ? res.json('csrfToken') : null
  if (!token || !csrf) fail(`вход ${login}: ${res.status} ${res.body}`)
  return { token, csrf }
}

function call(session, method, path, body, op) {
  const params = { headers: headers(session, body !== undefined), tags: { op } }
  const res = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    params,
  )
  check(res, { [`${op}: 2xx`]: (r) => r.status >= 200 && r.status < 300 })
  return res
}

const pad = (n) => String(n).padStart(3, '0')

/** Пространство профиля: участники — сотрудники рабочих циклов, 60 папок. */
export function setup() {
  const admin = signIn(ADMIN, ADMIN_PASSWORD, { op: 'setup' })
  const space = call(
    admin,
    'POST',
    '/spaces',
    {
      key: `perf-${Date.now()}`,
      name: 'Нагрузочный профиль',
      kind: 'team',
      description: 'Создано infra/perf/k6/api-basic.js',
    },
    'setup',
  ).json('id')
  if (!space) fail('пространство профиля не создано')

  const users = call(admin, 'GET', '/users?q=user&limit=200', undefined, 'setup').json('items')
  const byLogin = Object.fromEntries(users.map((u) => [u.login, u.id]))
  for (let i = 1; i <= USERS; i += 1) {
    const userId = byLogin[`user${pad(i)}`]
    if (!userId) fail(`нет сотрудника user${pad(i)} — загрузите демо-данные (kchs seed)`)
    call(admin, 'POST', `/spaces/${space}/members`, { userId, role: 'editor' }, 'setup')
  }

  const folders = []
  for (let i = 1; i <= FOLDERS; i += 1) {
    const res = call(
      admin,
      'POST',
      '/folders',
      { name: `Нагрузочная папка ${i}`, spaceId: space },
      'setup',
    )
    folders.push(res.json('id'))
  }
  return { space, folders }
}

let session = null

export function work(data) {
  // Каждый виртуальный пользователь — свой сотрудник и своя сессия
  if (!session) {
    session = signIn(`user${pad(((exec.vu.idInTest - 1) % USERS) + 1)}`, USER_PASSWORD, {
      op: 'setup',
    })
  }

  call(session, 'GET', '/me', undefined, 'me')

  const list = call(
    session,
    'GET',
    `/objects?spaceId=${data.space}&limit=50`,
    undefined,
    'objects_list',
  )
  const items = list.status === 200 ? list.json('items') : []
  const target =
    items.length > 0 ? items[Math.floor(Math.random() * items.length)].id : data.folders[0]
  call(session, 'GET', `/objects/${target}`, undefined, 'object')

  call(session, 'GET', '/inbox?limit=50', undefined, 'inbox')
  call(session, 'GET', `/search?q=${encodeURIComponent('Нагрузочная папка')}`, undefined, 'search')

  const iteration = exec.scenario.iterationInTest
  const folder = call(
    session,
    'POST',
    '/folders',
    {
      name: `Папка цикла ${iteration}`,
      spaceId: data.space,
    },
    'folder_create',
  ).json('id')

  const upload = call(
    session,
    'POST',
    '/files/upload-sessions',
    {
      name: `замер-${iteration}.txt`,
      size: 1024,
      mime: 'text/plain',
      spaceId: data.space,
      folderId: folder,
    },
    'upload_session',
  )
  // Сам файл браузер кладёт в S3 напрямую по подписанной ссылке — API в этом не участвует
  if (upload.status === 200) {
    call(
      session,
      'DELETE',
      `/files/upload-sessions/${upload.json('uploadId')}`,
      undefined,
      'upload_abort',
    )
  }

  call(session, 'GET', `/objects/${target}/discussion`, undefined, 'discussion')
  call(
    session,
    'POST',
    `/objects/${folder}/discussion/messages`,
    {
      body: { type: 'doc', content: [] },
      text: `Замер ${iteration}`,
      attachments: [],
      mentions: [],
      mentionedObjectIds: [],
    },
    'message_post',
  )
}

export function login() {
  const n = USERS + (exec.scenario.iterationInTest % 10) + 1
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ login: `user${pad(n)}`, password: USER_PASSWORD }),
    {
      headers: { 'content-type': 'application/json' },
      tags: { op: 'login' },
    },
  )
  check(res, { 'login: 200': (r) => r.status === 200 })
  const token = res.cookies[COOKIE]?.[0]?.value
  if (token && res.status === 200) {
    // Сессии входа не копятся: выход сразу
    http.post(`${API}/auth/logout`, null, {
      headers: headers({ token, csrf: res.json('csrfToken') }, false),
      tags: { op: 'setup' },
    })
  }
}

/** Итог — таблица p95 по операциям и, если задан KCHS_PERF_OUT, полный JSON. */
export function handleSummary(data) {
  const rows = []
  for (const [name, metric] of Object.entries(data.metrics)) {
    const match = /^http_req_duration\{op:(.+)\}$/.exec(name)
    if (!match) continue
    const failed = Object.values(metric.thresholds ?? {}).some((t) => !t.ok)
    const v = metric.values
    rows.push(
      `${match[1].padEnd(16)} ${String(v.count).padStart(6)} ${v.med.toFixed(1).padStart(8)} ` +
        `${v['p(95)'].toFixed(1).padStart(8)} ${v.max.toFixed(1).padStart(8)}  ${failed ? 'ВНЕ БЮДЖЕТА' : 'в бюджете'}`,
    )
  }
  const failedRate = data.metrics.http_req_failed?.values.rate ?? 0
  const text = [
    '',
    `k6: ${API}, ${RATE} цикл/с, ${DURATION}`,
    `${'операция'.padEnd(16)} ${'запросов'.padStart(6)} ${'медиана'.padStart(8)} ${'p95, мс'.padStart(8)} ${'макс'.padStart(8)}`,
    ...rows.sort(),
    `ошибки HTTP: ${(failedRate * 100).toFixed(2)} %`,
    '',
  ].join('\n')
  const out = { stdout: text }
  if (__ENV.KCHS_PERF_OUT) out[__ENV.KCHS_PERF_OUT] = JSON.stringify(data, null, 2)
  return out
}
