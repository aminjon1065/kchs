import type { HttpMethod } from '@kchs/contracts'
import type { RegisteredRoute } from '~/shared/http/route.js'
import { requiredScope } from './scopes.js'

/**
 * Шлюз DMZ (ADR-0200): какие маршруты API доступны из интернета.
 *
 *  - `public` — маршрут без входа, явно объявленный в таблице маршрутов
 *    (`exposure: 'public'`): входящие вебхуки, проверка подписи, лента
 *    предупреждений, приём координат;
 *  - `token` — маршрут публичного API, доступный токену с областью (ADR-0097):
 *    правило одно и то же внутри и снаружи, список не ведётся руками.
 *
 * Всё остальное снаружи закрыто: вход и сессии, личный кабинет, администрирование,
 * гостевые ссылки, служебные маршруты движка, редактор и печать. Тот же расчёт
 * строит белый список шлюза (`pnpm --filter @kchs/api dmz:gen`) и проверяет запрос,
 * пришедший через шлюз, в самом api — вторым рубежом.
 */
export type ExternalAccess = 'public' | 'token'

/** Префиксы, закрытые снаружи при любых признаках маршрута. */
const NEVER_PREFIXES = ['/auth', '/me', '/admin', '/internal', '/share', '/office', '/print']

/** Признаки маршрута, по которым решается доступ снаружи. */
export type GatewayRoute = Pick<
  RegisteredRoute,
  'method' | 'url' | 'auth' | 'tags' | 'readOnly' | 'exposure'
>

function insideApi(url: string): string {
  return url.startsWith('/api/v1') ? url.slice('/api/v1'.length) : url
}

function underNever(path: string): boolean {
  return NEVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** Доступ к маршруту снаружи; `null` — закрыт. */
export function externalAccess(route: GatewayRoute): ExternalAccess | null {
  const path = insideApi(route.url)
  if (route.exposure === 'public') {
    // Объявление противоречит политике — это ошибка конфигурации, а не «закрыто»
    if (underNever(path) || route.auth !== 'public') {
      throw new Error(
        `Маршрут ${route.method} ${route.url} объявлен открытым снаружи (exposure: 'public'), ` +
          'но это вход, служебный маршрут или маршрут с сессией (ADR-0200)',
      )
    }
    return 'public'
  }
  if (underNever(path)) return null
  if (route.auth === 'public') return null
  if (typeof route.auth === 'object' && 'engineJob' in route.auth) return null
  const { scope } = requiredScope({
    method: route.method,
    url: path,
    tags: route.tags,
    ...(route.readOnly ? { readOnly: true } : {}),
  })
  return scope ? 'token' : null
}

/** Символы пути, которые генератор переносит в шаблон как есть. */
const LITERAL = /^[A-Za-z0-9/_.-]*$/
const PARAM = /:[A-Za-z_][A-Za-z0-9_]*/g

/**
 * Регулярное выражение пути для шлюза: параметр — один сегмент, остальное —
 * буквально, точка — классом `[.]` (без обратной косой: её пришлось бы ещё раз
 * экранировать в строке CEL).
 */
export function gatewayPattern(url: string): string {
  const full = url.startsWith('/api/v1') ? url : `/api/v1${url}`
  const parts = full.split(PARAM)
  for (const part of parts) {
    if (!LITERAL.test(part)) {
      throw new Error(`Путь ${full}: символ вне [A-Za-z0-9/_.-] — шлюз его не опишет`)
    }
  }
  return `^${parts.map((part) => part.replaceAll('.', '[.]')).join('[^/]+')}$`
}

/** Сегмент пути: буквальный или с параметром (`:id`, `:y.pbf`). */
interface Segment {
  dynamic: boolean
  text: string
  pattern: RegExp
}

function segments(url: string): Segment[] {
  const full = url.startsWith('/api/v1') ? url : `/api/v1${url}`
  return full
    .split('/')
    .slice(1)
    .map((text) => {
      const dynamic = /:[A-Za-z_]/.test(text)
      const body = text.split(PARAM).map((part) => part.replaceAll('.', '[.]'))
      return { dynamic, text, pattern: new RegExp(`^${body.join('[^/]+')}$`) }
    })
}

/** Есть ли путь, который подходит под оба маршрута. */
function overlaps(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false
  return a.every((left, index) => {
    const right = b[index] as Segment
    if (!left.dynamic && !right.dynamic) return left.text === right.text
    if (!left.dynamic) return right.pattern.test(left.text)
    if (!right.dynamic) return left.pattern.test(right.text)
    return true
  })
}

/**
 * Общие пути двух пересекающихся маршрутов маршрутизатор отдаёт `a`: в первом
 * сегменте, где они различаются, у `a` буквальный текст, а у `b` — параметр
 * (find-my-way предпочитает буквальный сегмент параметру).
 */
function prefers(a: Segment[], b: Segment[]): boolean {
  for (const [index, left] of a.entries()) {
    const right = b[index] as Segment
    if (left.dynamic === right.dynamic) continue
    return !left.dynamic
  }
  return false
}

/** Путь-образец маршрута: параметр — `x1`. */
export function samplePath(url: string): string {
  const full = url.startsWith('/api/v1') ? url : `/api/v1${url}`
  return full.replace(PARAM, 'x1')
}

interface GatewayLine {
  pattern: string
  methods: HttpMethod[]
}

const METHOD_ORDER: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function lines(routes: readonly GatewayRoute[]): GatewayLine[] {
  const byPattern = new Map<string, Set<HttpMethod>>()
  for (const route of routes) {
    const pattern = gatewayPattern(route.url)
    const methods = byPattern.get(pattern) ?? new Set<HttpMethod>()
    methods.add(route.method)
    byPattern.set(pattern, methods)
  }
  return [...byPattern.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pattern, methods]) => ({
      pattern,
      methods: METHOD_ORDER.filter((method) => methods.has(method)),
    }))
}

function matcher(name: string, list: GatewayLine[]): string {
  const body = list.map((line, index) => {
    const methods = line.methods.map((method) => `method('${method}')`).join(' || ')
    const condition = `path_regexp('${line.pattern}') && (${methods})`
    return `\t${index === 0 ? '   ' : '|| '}(${condition})`
  })
  // Пустой список — матчер, который не совпадает ни с чем
  if (body.length === 0) body.push("\t   (path('/never/matches') && method('GET'))")
  return `@${name} expression <<CEL\n${body.join('\n')}\n\tCEL`
}

/** Маршруты белого списка: открытые снаружи и закрытые, которые они заслоняют. */
export function gatewayPlan(routes: readonly GatewayRoute[]): {
  public: GatewayRoute[]
  token: GatewayRoute[]
  shadowed: GatewayRoute[]
} {
  const open = routes.filter((route) => externalAccess(route) !== null)
  const closed = routes.filter((route) => externalAccess(route) === null)
  // Закрытый маршрут, общие пути которого с открытым шаблоном маршрутизатор отдаёт
  // ему (`GET /documents/registry.xlsx` рядом с `GET /documents/:id`), шлюз
  // перечисляет отдельно и закрывает раньше открытых
  const shadowed = closed.filter((route) => {
    const own = segments(route.url)
    return open.some((other) => {
      if (other.method !== route.method) return false
      const theirs = segments(other.url)
      return overlaps(own, theirs) && prefers(own, theirs)
    })
  })
  // Заслонённый шаблон не должен закрывать открытый маршрут
  const closing = shadowed.map((route) => ({
    method: route.method,
    pattern: new RegExp(gatewayPattern(route.url)),
  }))
  for (const route of open) {
    const sample = samplePath(route.url)
    const blocker = closing.find(
      (item) => item.method === route.method && item.pattern.test(sample),
    )
    if (blocker) {
      throw new Error(
        `Шлюз DMZ: открытый маршрут ${route.method} ${route.url} перекрыт закрытым ` +
          `${blocker.pattern.source} — разведите пути (ADR-0200)`,
      )
    }
  }
  return {
    public: open.filter((route) => externalAccess(route) === 'public'),
    token: open.filter((route) => externalAccess(route) === 'token'),
    shadowed,
  }
}

/**
 * Белый список шлюза — сниппет Caddy с тремя именованными матчерами (ADR-0200):
 * `@kchs_dmz_closed` — закрытые маршруты, заслонённые открытыми шаблонами (шлюз
 * отвечает на них 404 раньше остальных), `@kchs_dmz_public` — маршруты без входа,
 * `@kchs_dmz_token` — маршруты публичного API по токену. Файл генерируется и
 * сверяется в CI; править его руками нельзя.
 */
export function renderGatewayRoutes(routes: readonly GatewayRoute[]): string {
  const plan = gatewayPlan(routes)
  const closedLines = lines(plan.shadowed)
  const publicLines = lines(plan.public)
  const tokenLines = lines(plan.token)
  return [
    '# Белый список шлюза DMZ — сгенерирован из таблицы маршрутов (ADR-0200).',
    '# Не править руками: pnpm --filter @kchs/api dmz:gen; проверка — dmz:gen --check.',
    `# Шаблонов путей: без входа — ${publicLines.length}, по токену API — ${tokenLines.length},`,
    `# закрытых, заслонённых открытыми, — ${closedLines.length}.`,
    '',
    matcher('kchs_dmz_closed', closedLines),
    '',
    matcher('kchs_dmz_public', publicLines),
    '',
    matcher('kchs_dmz_token', tokenLines),
    '',
  ].join('\n')
}

export type GatewaySection = 'closed' | 'public' | 'token'

/** Строки белого списка разбором сгенерированного файла: шаблон пути и методы. */
export function parseGatewayRoutes(text: string): Record<GatewaySection, GatewayLine[]> {
  const result: Record<GatewaySection, GatewayLine[]> = { closed: [], public: [], token: [] }
  let current: GatewaySection | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const opened = /^@kchs_dmz_(closed|public|token) /.exec(line)?.[1] as GatewaySection | undefined
    if (opened) current = opened
    else if (line === 'CEL') current = null
    const pattern = /path_regexp\('([^']+)'\)/.exec(line)?.[1]
    if (!current || !pattern) continue
    const methods = [...line.matchAll(/method\('([A-Z]+)'\)/g)].map(
      (match) => match[1] as HttpMethod,
    )
    result[current].push({ pattern, methods })
  }
  return result
}

/**
 * Что шлюз сделает с запросом по сгенерированному файлу — так же, как Caddy:
 * сначала закрытые, затем без входа, затем по токену; иначе 404.
 */
export function gatewayVerdict(
  parsed: Record<GatewaySection, GatewayLine[]>,
  method: HttpMethod,
  path: string,
): 'closed' | 'public' | 'token' | 'none' {
  const hit = (section: GatewaySection) =>
    parsed[section].some(
      (line) => line.methods.includes(method) && new RegExp(line.pattern).test(path),
    )
  if (hit('closed')) return 'closed'
  if (hit('public')) return 'public'
  if (hit('token')) return 'token'
  return 'none'
}

/** Заголовок, которым шлюз DMZ помечает запрос снаружи (ставит сам, поверх клиентского). */
export const GATEWAY_ZONE_HEADER = 'x-kchs-zone'

/**
 * Доступ снаружи для маршрута запроса — второй рубеж в api: запрос, пришедший через
 * шлюз, проходит, только если маршрут открыт снаружи. Белый список шлюза сам по себе
 * этого не гарантирует: правило могли ослабить на хосте DMZ.
 */
export function requestExternalAccess(request: {
  method: string
  routeOptions?: { url?: string | undefined; config?: unknown } | undefined
}): ExternalAccess | null {
  const url = request.routeOptions?.url
  if (!url) return null
  const config = (request.routeOptions?.config ?? {}) as {
    auth?: RegisteredRoute['auth']
    apiTags?: string[]
    readOnly?: boolean
    exposure?: 'public'
  }
  if (!config.auth) return null
  const method = (request.method === 'HEAD' ? 'GET' : request.method) as HttpMethod
  try {
    return externalAccess({
      method,
      url,
      auth: config.auth,
      ...(config.apiTags ? { tags: config.apiTags } : {}),
      ...(config.readOnly ? { readOnly: true } : {}),
      ...(config.exposure ? { exposure: config.exposure } : {}),
    })
  } catch {
    return null
  }
}
