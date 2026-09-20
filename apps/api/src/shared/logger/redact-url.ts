/**
 * Адрес запроса в журнале и в ответе об ошибке (17-security.md §4).
 *
 * Часть секретов живёт не в заголовке, а прямо в пути: гостевая ссылка
 * (`/share/{токен}/open`), входящий вебхук интеграции (`/hooks/{id}/{секрет}`)
 * и вход правила автоматизации (`/hooks/rules/{id}/{токен}`). Заголовок
 * `Authorization` из журнала вычищается списком `redact`, а путь — нет, и
 * такой секрет попадал в каждую строку «incoming request», то есть в Loki.
 *
 * Строка запроса вычищается целиком — так же, как в трассах (ADR-0045): там
 * поисковые фразы и токены ссылок, а для разбора инцидента хватает шаблона
 * маршрута и кода ответа.
 */

const CENSORED = '[скрыто]'

/** Секрет — сегмент после того, что остаётся в группе. */
const SECRET_SEGMENTS: RegExp[] = [
  /^(\/api\/v1\/hooks\/rules\/[^/]+\/)[^/]+/,
  /^(\/api\/v1\/hooks\/[^/]+\/)[^/]+/,
  /^(\/api\/v1\/share\/)[^/]+/,
]

/** Начало пути: у полного адреса — первый `/` после `scheme://`. */
function pathStart(url: string): number {
  const scheme = url.indexOf('://')
  if (scheme === -1) return 0
  const slash = url.indexOf('/', scheme + 3)
  return slash === -1 ? url.length : slash
}

/**
 * Секрет в пути и строка запроса не попадают в журнал и в ответ об ошибке.
 * Принимает и путь (`/api/v1/…`), и полный адрес — трассы пишут второе.
 */
export function redactUrl(url: string): string {
  const origin = url.slice(0, pathStart(url))
  const tail = url.slice(origin.length)
  const cut = tail.search(/[?#]/)
  const path = cut === -1 ? tail : tail.slice(0, cut)
  const rest = cut === -1 ? '' : tail[cut] + CENSORED
  for (const rule of SECRET_SEGMENTS) {
    const masked = path.replace(rule, `$1${CENSORED}`)
    if (masked !== path) return origin + masked + rest
  }
  return origin + path + rest
}
