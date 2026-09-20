import type { Integration } from '@kchs/contracts'
import { telegramBotUsername, telegramConfigured } from '~/modules/telegram/public.js'
import { config } from '~/shared/config/index.js'
import { mailConfigured, verifyMail } from '~/shared/mail/index.js'

/**
 * Встроенные службы установки в общем учёте интеграций (ADR-0097).
 *
 * SMTP и Telegram-бот настроены переменными окружения и работают с фазы 0/1.
 * Переносить их в таблицу значило бы переделывать работающее; вместо этого они
 * показываются в общем списке как `source: 'env'` — только для чтения, с тем же
 * статусом и той же кнопкой «Проверить соединение».
 */
const ENV_KEYS = ['smtp', 'telegram'] as const
export type BuiltinKey = (typeof ENV_KEYS)[number]

export function isBuiltinKey(key: string): key is BuiltinKey {
  return (ENV_KEYS as readonly string[]).includes(key)
}

function entry(input: {
  key: BuiltinKey
  kind: Integration['kind']
  name: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
}): Integration {
  return {
    id: `builtin:${input.key}`,
    source: 'env',
    key: input.key,
    kind: input.kind,
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    config: input.config,
    secretKeys: [],
    status: input.enabled ? 'unknown' : 'disabled',
    statusMessage: null,
    lastCheckAt: null,
    lastSyncAt: null,
    inboundEnabled: false,
    inboundUrl: null,
    createdAt: null,
    updatedAt: null,
  }
}

export function builtinIntegrations(): Integration[] {
  const env = config()
  return [
    entry({
      key: 'smtp',
      kind: 'smtp',
      name: 'Исходящая почта (SMTP)',
      description: 'Уведомления, дайджесты, рассылки отчётов',
      enabled: mailConfigured(),
      // Ни адреса сервера, ни пароля: строка подключения — секрет установки
      config: { from: env.SMTP_FROM },
    }),
    entry({
      key: 'telegram',
      kind: 'telegram',
      name: 'Telegram-бот',
      description: 'Привязка аккаунта, уведомления и кнопки действий',
      enabled: telegramConfigured(),
      config: { apiUrl: env.TELEGRAM_API_URL, polling: env.TELEGRAM_POLLING },
    }),
  ]
}

/** Проверка связи для встроенной службы. */
export async function checkBuiltin(key: string): Promise<{ ok: boolean; message: string }> {
  if (key === 'smtp') return verifyMail()
  if (key === 'telegram') {
    if (!telegramConfigured()) {
      return { ok: false, message: 'Telegram-бот не настроен: задайте TELEGRAM_BOT_TOKEN' }
    }
    const username = await telegramBotUsername()
    return username
      ? { ok: true, message: `Бот на связи: @${username}` }
      : { ok: false, message: 'Telegram сейчас недоступен' }
  }
  return { ok: false, message: 'Неизвестная встроенная интеграция' }
}
