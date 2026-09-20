import { MailboxConfig } from '@kchs/contracts'
import { ImapFlow } from 'imapflow'
import { logger } from '../logger/index.js'

/**
 * Доступ к ящику канцелярии по IMAP (14-automation-integrations.md §5,
 * 18-tech-stack.md — imapflow). Здесь только транспорт: открыть соединение,
 * забрать непрочитанные письма папки целиком и пометить разобранные. Разбор и
 * решения — в модуле документов (ADR-0113).
 *
 * Транспорт лежит рядом с отправкой почты (`shared/mail`), а не в модуле:
 * ящик открывают двое — опрос почты в документах и «Проверить соединение» у
 * интеграций, а модули друг друга не читают.
 */

/** Сколько байт писем набирается за один прогон: всё лежит в памяти процесса. */
const MAX_BATCH_BYTES = 128 * 1024 * 1024

export interface FetchedLetter {
  uid: number
  uidValidity: string | null
  /** Письмо целиком (RFC 822): его разбирает `parseLetter`. */
  source: Buffer
}

export interface MailboxPort {
  fetch(config: MailboxConfig, password: string, limit: number): Promise<FetchedLetter[]>
  markSeen(config: MailboxConfig, password: string, uids: number[]): Promise<void>
  check(config: MailboxConfig, password: string): Promise<{ ok: boolean; message: string }>
}

function client(config: MailboxConfig, password: string): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: password },
    // Собственный журнал imapflow шумит на уровне отладки и печатает тело письма
    logger: false,
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
    // Без TLS на 143-м порту соединение поднимается STARTTLS, если сервер умеет
    ...(config.secure ? {} : { requireTLS: false }),
  })
}

async function withMailbox<T>(
  config: MailboxConfig,
  password: string,
  action: (imap: ImapFlow) => Promise<T>,
): Promise<T> {
  const imap = client(config, password)
  await imap.connect()
  try {
    const lock = await imap.getMailboxLock(config.folder)
    try {
      return await action(imap)
    } finally {
      lock.release()
    }
  } finally {
    await imap.logout().catch(() => imap.close())
  }
}

/** Рабочая реализация порта: настоящий IMAP-сервер. */
export const imapMailbox: MailboxPort = {
  async fetch(config, password, limit) {
    return withMailbox(config, password, async (imap) => {
      const box = imap.mailbox
      const uidValidity = box && typeof box !== 'boolean' ? String(box.uidValidity ?? '') : null
      const letters: FetchedLetter[] = []
      let bytes = 0
      // Берём непрочитанные: прочитанные письма ящика — уже разобранные или
      // просмотренные человеком, и трогать их повторно не нужно
      for await (const message of imap.fetch({ seen: false }, { uid: true, source: true })) {
        if (!message.source) continue
        letters.push({
          uid: message.uid,
          uidValidity: uidValidity || null,
          source: Buffer.from(message.source),
        })
        bytes += message.source.length
        // Пачка ограничена не только числом писем, но и объёмом: письмо целиком
        // лежит в памяти, и `batchSize` тяжёлых писем её бы исчерпали. Остаток
        // ящика достаётся следующему прогону — непрочитанным ничего не теряется
        if (letters.length >= limit || bytes >= MAX_BATCH_BYTES) break
      }
      return letters
    })
  },

  async markSeen(config, password, uids) {
    if (uids.length === 0) return
    await withMailbox(config, password, async (imap) => {
      await imap.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true })
    })
  },

  async check(config, password) {
    try {
      const count = await withMailbox(config, password, async (imap) => {
        const box = imap.mailbox
        return box && typeof box !== 'boolean' ? (box.exists ?? 0) : 0
      })
      return { ok: true, message: `Ящик открыт, писем в папке: ${count}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'нет соединения'
      logger().warn({ host: config.host, error: message }, 'IMAP: проверка связи не удалась')
      return { ok: false, message }
    }
  },
}

/** Подмена порта в тестах: настоящий сервер для разбора письма не нужен. */
let port: MailboxPort = imapMailbox
export function mailboxPort(): MailboxPort {
  return port
}
export function setMailboxPort(next: MailboxPort): void {
  port = next
}

/**
 * Конфигурация ящика из записи интеграции: разобранная настройка и пароль
 * либо понятная причина, почему ящик открыть нельзя. Причина уходит и в
 * журнал синхронизаций, и в ответ кнопки «Проверить соединение».
 */
export function readMailbox(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): { config: MailboxConfig; password: string } | { error: string } {
  const parsed = MailboxConfig.safeParse(config)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { error: `конфигурация ящика неполна — ${issues}` }
  }
  const password = secrets.password
  if (!password) return { error: 'не задан секрет password' }
  return { config: parsed.data, password }
}

/** «Проверить соединение» для интеграции `imap` (ADR-0097, ADR-0113). */
export async function checkMailbox(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  const read = readMailbox(config, secrets)
  if ('error' in read) return { ok: false, message: read.error }
  return mailboxPort().check(read.config, read.password)
}
