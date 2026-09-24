import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { outboundAddressDenied, outboundGet } from '~/shared/net/outbound.js'

/**
 * Чтение внешнего ICS-канала для подписки (ADR-0081, 17-security.md): адрес
 * задаёт пользователь, поэтому запрос не должен становиться ходом во
 * внутренние сервисы. Закрыты loopback, link-local (метаданные облака), «этот
 * узел», multicast и частные сети (включаются настройкой
 * `CALENDAR_FEEDS_ALLOW_PRIVATE` для каналов закрытого контура). Адрес
 * проверяется после разрешения имени, в момент соединения, и на каждом
 * перенаправлении. Ответ — не больше 5 МБ, 15 секунд. Запрос идёт общим
 * исходящим клиентом — через исходящий прокси, если он задан (ADR-0132).
 */

const TIMEOUT_MS = 15_000
const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const WHAT = 'календарь по адресу'

const denyPrivate = () => !config().CALENDAR_FEEDS_ALLOW_PRIVATE

/** Адрес закрыт для чтения канала; IPv4 в IPv6 (`::ffff:a.b.c.d`) проверяется как IPv4. */
export function feedAddressDenied(address: string): boolean {
  return outboundAddressDenied(address, denyPrivate())
}

/** Текст канала подписки; сбой — `dependency_failed` с причиной без содержимого ответа. */
export async function fetchIcs(address: string): Promise<string> {
  const response = await outboundGet(address, {
    what: WHAT,
    accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1',
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    denyPrivateNetworks: denyPrivate(),
  })
  if (response.status !== 200) {
    throw errors.dependencyFailed('Календарь по адресу не отдан', { status: response.status })
  }
  return response.body.toString('utf8')
}
