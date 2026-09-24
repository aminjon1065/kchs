import { eq } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { type IntegrationRow, integrations } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { type OutboundOptions, type OutboundResponse, outboundGet } from '~/shared/net/outbound.js'
import { readSecrets } from './integration-service.js'

/**
 * Ссылка на секрет интеграции в адресе или заголовке запроса: `{secret:mapKey}`.
 * Сервер подставляет значение при запросе — в настройке источника, в ответах API и
 * в сообщениях об ошибке его нет (ADR-0132).
 */
const SECRET_REF = /\{secret:([A-Za-z0-9_.-]{1,64})\}/g

/** В строке есть ссылка на секрет интеграции. */
export function hasSecretRef(value: string): boolean {
  return new RegExp(SECRET_REF.source).test(value)
}

async function load(integrationId: string): Promise<IntegrationRow> {
  const [row] = await db()
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1)
  if (!row) throw errors.notFound('Интеграция')
  if (row.kind !== 'http') {
    throw errors.validation('Секреты запроса хранит интеграция вида «HTTP»')
  }
  if (!row.enabled) throw errors.conflict('Интеграция выключена')
  return row
}

function render(text: string, secrets: Record<string, string>, encode: boolean): string {
  return text.replace(SECRET_REF, (_match, name: string) => {
    const value = secrets[name]
    if (value === undefined) throw errors.validation(`В интеграции нет секрета «${name}»`)
    return encode ? encodeURIComponent(value) : value
  })
}

/**
 * Запрос по адресу с секретами интеграции вида `http` (ADR-0132): ключ API
 * подставляется здесь и дальше модуля интеграций не уходит — вызывающий получает
 * только ответ. Право пользоваться интеграцией проверяет вызывающий.
 */
export const HttpIntegration = {
  /** Интеграция годится для запроса: вид `http`, включена. */
  async assertUsable(integrationId: string): Promise<void> {
    await load(integrationId)
  },

  async get(
    integrationId: string,
    target: { url: string; headers: Record<string, string> },
    options: Omit<OutboundOptions, 'headers'>,
  ): Promise<OutboundResponse> {
    const row = await load(integrationId)
    const secrets = readSecrets(row)
    const url = render(target.url, secrets, true)
    const headers = Object.fromEntries(
      Object.entries(target.headers).map(([name, value]) => [name, render(value, secrets, false)]),
    )
    return outboundGet(url, { ...options, headers })
  },
}
