import type { ApiScope, ApiScopeResource } from '@kchs/contracts'

/**
 * Какая область нужна маршруту (ADR-0097).
 *
 * Ресурс области — тег маршрута публичного API: теги уже расставлены у всех
 * маршрутов и попадают в OpenAPI, поэтому таблица одна и не расходится с
 * действительностью. Незнакомый тег означает «токенам недоступно»: список
 * закрыт по умолчанию, новый модуль сам решает, открывать ли свои маршруты.
 */
const TAG_RESOURCE: Record<string, ApiScopeResource> = {
  objects: 'objects',
  access: 'objects',
  tags: 'objects',
  views: 'views',
  data: 'datasets',
  gis: 'gis',
  documents: 'documents',
  acknowledgments: 'documents',
  tasks: 'tasks',
  files: 'files',
  reports: 'reports',
  calendar: 'calendar',
  'business-calendar': 'calendar',
  processes: 'processes',
  spaces: 'spaces',
  org: 'org',
  discussions: 'discussions',
  chat: 'chat',
  meetings: 'meetings',
  notifications: 'notifications',
  inbox: 'notifications',
  announcements: 'notifications',
  search: 'search',
  jobs: 'jobs',
  integrations: 'integrations',
}

/**
 * Пути, закрытые для токенов при любых областях: личный кабинет, вход,
 * администрирование и внутренние маршруты движка. Токен не должен становиться
 * способом сменить пароль, выпустить второй токен или войти в режим
 * администратора (17-security.md §2, §3).
 */
const DENIED_PREFIXES = ['/me', '/auth', '/internal', '/admin', '/share', '/hooks']

/** Теги, закрытые для токенов независимо от пути. */
const DENIED_TAGS = new Set(['auth', 'me', 'internal', 'admin', 'ai'])

export interface ScopeRequirement {
  /** Требуемая область или `null`, если маршрут токенам недоступен. */
  scope: ApiScope | null
}

/**
 * `readOnly` — тот же признак, которым помечены POST без изменения данных
 * (выполнить запрос, посчитать показатель, сводки объектов): для них хватает
 * области чтения.
 */
export function requiredScope(input: {
  method: string
  /** Путь маршрута внутри `/api/v1` (`/datasets/:id/rows`). */
  url: string
  tags: readonly string[] | undefined
  readOnly?: boolean
}): ScopeRequirement {
  const path = input.url.startsWith('/api/v1') ? input.url.slice('/api/v1'.length) : input.url
  if (DENIED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return { scope: null }
  }

  const tags = input.tags ?? []
  if (tags.some((tag) => DENIED_TAGS.has(tag))) return { scope: null }

  const resource = tags.map((tag) => TAG_RESOURCE[tag]).find((value) => value !== undefined)
  if (!resource) return { scope: null }

  const reads = input.method === 'GET' || input.method === 'HEAD' || input.readOnly === true
  return { scope: `${reads ? 'read' : 'write'}:${resource}` as ApiScope }
}
