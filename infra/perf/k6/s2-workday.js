// Нагрузочный профиль «рабочий день S2»: одновременные пользователи, Входящие,
// «Мой день», списки, поиск и чаты. Масштаб S2 — больше 300 одновременно
// работающих сотрудников (15-admin-operations.md §8): по умолчанию профиль
// изображает 1000, то есть примерно 17 рабочих циклов в секунду (столько же
// сотрудников на цикл, сколько в профиле S1 api-basic).
//
// Бюджеты — 04-verification.md §4: базовые операции p95 ≤ 200 мс, поиск
// (объектов и сообщений) p95 ≤ 100 мс. Вход дорог намеренно (argon2id) и в
// бюджет базовых не входит.
//
// Запуск — KCHS_PERF_PROFILE=s2-workday bash infra/perf/run-k6.sh
//   KCHS_PERF_API=https://kchs.example.org/api/v1  адрес установки (кластер)
//   KCHS_PERF_CONCURRENT=1000                      одновременных сотрудников
//   KCHS_PERF_RATE=17                              циклов/с вместо расчётного
//   KCHS_PERF_DURATION=10m                         плато нагрузки
//
// Прогонять на машине разработчика не нужно: профиль рассчитан на кластер.
import { fail } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'
import {
  ADMIN,
  ADMIN_PASSWORD,
  API,
  budgets,
  COOKIE,
  call,
  headers,
  INSECURE_TLS,
  must,
  num,
  pad,
  pick,
  rampingStages,
  SEED_USERS,
  signIn,
  summary,
  text,
  USER_PASSWORD,
} from './lib/kchs.js'

/** Одновременно работающих сотрудников; 60 сотрудников дают один цикл в секунду. */
const CONCURRENT = num('KCHS_PERF_CONCURRENT', 1000)
const RATE = num('KCHS_PERF_RATE', Math.max(1, Math.round(CONCURRENT / 60)))
/** Доля циклов с чатом: сообщения пишут не в каждом цикле. */
const CHAT_RATE = num('KCHS_PERF_CHAT_RATE', Math.max(1, Math.round(RATE / 2)))
const DURATION = text('KCHS_PERF_DURATION', '5m')
/** Сотрудники рабочих циклов — user001…userN; для входа — следующие десять. */
const USERS = Math.min(num('KCHS_PERF_USERS', 40), SEED_USERS - 10)
const FOLDERS = 60
const LOGIN_BUDGET_MS = num('KCHS_PERF_LOGIN_BUDGET_MS', 500)

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
const SEARCH_OPS = ['search', 'chat_search']

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    workday: {
      executor: 'ramping-arrival-rate',
      exec: 'workday',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(USERS, RATE * 3),
      maxVUs: Math.max(USERS, RATE * 3) * 3,
      stages: rampingStages(RATE, DURATION),
    },
    chat: {
      executor: 'ramping-arrival-rate',
      exec: 'chat',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(USERS, CHAT_RATE * 3),
      maxVUs: Math.max(USERS, CHAT_RATE * 3) * 3,
      stages: rampingStages(CHAT_RATE, DURATION),
    },
    // Утренняя волна входов: организация за NAT входит с одного адреса
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
    ...budgets(Object.fromEntries(SEARCH_OPS.map((op) => [op, 'p(95)<100']))),
    ...budgets({ login: `p(95)<${LOGIN_BUDGET_MS}` }),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  setupTimeout: '300s',
}

/**
 * Пространство профиля с папками, участниками и каналом. Создаётся в установке
 * под нагрузкой — на общем стенде это видно участникам.
 */
export function prepareWorkday(admin) {
  const space = must(admin, 'POST', '/spaces', {
    key: `perf-s2-${Date.now()}`,
    name: 'Нагрузочный профиль S2',
    kind: 'team',
    description: 'Создано infra/perf/k6/s2-workday.js',
  }).json('id')

  const users = must(admin, 'GET', '/users?q=user&limit=200').json('items')
  const byLogin = Object.fromEntries(users.map((u) => [u.login, u.id]))
  const memberIds = []
  for (let i = 1; i <= USERS; i += 1) {
    const userId = byLogin[`user${pad(i)}`]
    if (!userId) fail(`нет сотрудника user${pad(i)} — загрузите демо-данные (kchs seed)`)
    must(admin, 'POST', `/spaces/${space}/members`, { userId, role: 'editor' })
    memberIds.push(userId)
  }

  const folders = []
  for (let i = 1; i <= FOLDERS; i += 1) {
    folders.push(
      must(admin, 'POST', '/folders', { name: `Нагрузочная папка S2 ${i}`, spaceId: space }).json(
        'id',
      ),
    )
  }

  // Канал профиля: в нём идут сообщения нагрузки. Каналы живут в пространстве
  const chatId = must(admin, 'POST', '/chats', {
    kind: 'channel',
    title: 'Нагрузочный канал S2',
    spaceId: space,
    memberIds,
    privacy: 'closed',
  }).json('id')

  return { space, folders, chatId }
}

export function setup() {
  return prepareWorkday(signIn(ADMIN, ADMIN_PASSWORD))
}

let session = null

function sessionOfVu() {
  if (!session) {
    session = signIn(`user${pad(((exec.vu.idInTest - 1) % USERS) + 1)}`, USER_PASSWORD)
  }
  return session
}

/** Цикл сотрудника: «Мой день», Входящие, списки, карточка, поиск. */
export function workday(input) {
  // Профиль s2-mixed передаёт данные всех частей в одном объекте
  const data = input.workday ?? input
  const s = sessionOfVu()
  call(s, 'GET', '/me', undefined, 'me')
  call(s, 'GET', '/inbox?limit=50', undefined, 'inbox')
  call(s, 'GET', '/inbox/counts', undefined, 'inbox_counts')
  call(s, 'GET', '/notifications?limit=20', undefined, 'notifications')
  call(s, 'GET', '/tasks/summary', undefined, 'tasks_summary')

  const list = call(s, 'GET', `/objects?spaceId=${data.space}&limit=50`, undefined, 'objects_list')
  const items = list.status === 200 ? list.json('items') : []
  const target = items.length > 0 ? pick(items).id : data.folders[0]
  call(s, 'GET', `/objects/${target}`, undefined, 'object')

  call(s, 'GET', `/search?q=${encodeURIComponent('Нагрузочная папка S2')}`, undefined, 'search')
}

/** Цикл беседы: список, лента, сообщение, отметка прочтения, поиск сообщений. */
export function chat(input) {
  const data = input.workday ?? input
  const s = sessionOfVu()
  call(s, 'GET', '/chats?section=all&limit=50', undefined, 'chat_list')
  call(s, 'GET', `/conversations/${data.chatId}/messages?limit=50`, undefined, 'chat_messages')

  const iteration = exec.scenario.iterationInTest
  const posted = call(
    s,
    'POST',
    `/conversations/${data.chatId}/messages`,
    {
      body: { type: 'doc', content: [] },
      text: `Замер S2 ${iteration}`,
      attachments: [],
      mentions: [],
      mentionedObjectIds: [],
    },
    'chat_post',
  )
  if (posted.status === 200) {
    call(
      s,
      'POST',
      `/conversations/${data.chatId}/read`,
      { messageId: posted.json('id') },
      'chat_read',
    )
  }
  const q = encodeURIComponent('Замер S2')
  call(s, 'GET', `/chats/search?q=${q}&limit=20`, undefined, 'chat_search')
}

/** Вход другого сотрудника: argon2id, отдельный бюджет. */
export function login() {
  const n = USERS + (exec.scenario.iterationInTest % 10) + 1
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ login: `user${pad(n)}`, password: USER_PASSWORD }),
    { headers: { 'content-type': 'application/json' }, tags: { op: 'login' } },
  )
  const token = res.cookies[COOKIE]?.[0]?.value
  if (token && res.status === 200) {
    // Сессии входа не копятся: выход сразу
    http.post(`${API}/auth/logout`, null, {
      headers: headers({ token, csrf: res.json('csrfToken') }, false),
      tags: { op: 'setup' },
    })
  }
}

export function handleSummary(data) {
  return summary(`рабочий день S2: ${CONCURRENT} сотрудников ≈ ${RATE} цикл/с, ${DURATION}`, data)
}
