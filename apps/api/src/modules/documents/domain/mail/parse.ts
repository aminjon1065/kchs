import type { MailboxFilters } from '@kchs/contracts'
import { simpleParser } from 'mailparser'

/**
 * Разбор письма канцелярии (08-documents.md §5, ADR-0113). Из письма нужны
 * ровно те поля, из которых складывается карточка входящего: отправитель,
 * тема, текст и вложения. Всё остальное — заголовки цепочки переписки —
 * сохраняется как есть, чтобы связь «ответ на» можно было достроить позже.
 */

export interface LetterAttachment {
  name: string
  mime: string
  content: Buffer
}

export interface ParsedLetter {
  /** `Message-ID` письма без угловых скобок; пусто — заголовка не было. */
  messageId: string
  fromEmail: string
  fromName: string | null
  toEmail: string | null
  subject: string
  /** Текст письма: текстовая часть, иначе — HTML, приведённый к тексту. */
  body: string
  sentAt: string | null
  inReplyTo: string | null
  references: string[]
  attachments: LetterAttachment[]
  /** Вложения, отброшенные пределами: их число видно в очереди «Из почты». */
  skippedAttachments: number
}

const MAX_BODY_CHARS = 100_000
const MAX_ATTACHMENT_NAME = 200
/**
 * Пределы вложений (17-security.md §5: «ограничение размеров»). Письмо приходит
 * снаружи и кладётся в хранилище целиком, поэтому пределы нужны здесь, а не
 * только у формы загрузки: без них одно письмо занимает память процесса и бакет.
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const MAX_ATTACHMENTS_BYTES = 128 * 1024 * 1024
export const MAX_ATTACHMENTS = 50

/** Уголки `<…>` у идентификаторов писем — часть формата, а не значения. */
function unwrap(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^<|>$/g, '')
}

/** Грубое приведение HTML-письма к тексту: карточке нужен смысл, не разметка. */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t ]+/g, ' ')
      // Открывающие теги оставляли пробел там, где абзац уже кончился
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * Имя вложения: без путей и управляющих символов, с разумной длиной. Имя
 * приходит из письма, то есть снаружи, — в ключ хранения оно попадает уже
 * очищенным (дальше его ещё раз приводит `safeName` модуля файлов).
 */
export function attachmentName(raw: string | undefined, index: number): string {
  const cleaned = (raw ?? '')
    .replace(/[/\\]/g, '_')
    .replace(/\p{Cc}|\p{Cf}/gu, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, MAX_ATTACHMENT_NAME) : `Вложение ${index + 1}`
}

/** Письмо целиком (RFC 822) — в вид, пригодный для карточки документа. */
export async function parseLetter(source: Buffer): Promise<ParsedLetter> {
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextLinks: true,
  })

  const from = mail.from?.value?.[0]
  const to = Array.isArray(mail.to) ? mail.to[0]?.value?.[0] : mail.to?.value?.[0]
  const text = (mail.text ?? '').trim()
  const body = (text.length > 0 ? text : htmlToText(mail.html || '')).slice(0, MAX_BODY_CHARS)
  const references = Array.isArray(mail.references)
    ? mail.references
    : mail.references
      ? [mail.references]
      : []

  const candidates = mail.attachments
    // Встроенные картинки подписи — не приложения к документу
    .filter((item) => item.contentDisposition !== 'inline' || !item.cid)
    .map((item, index) => ({
      name: attachmentName(item.filename, index),
      mime: item.contentType || 'application/octet-stream',
      content: Buffer.from(item.content),
    }))

  // Слишком большое и лишнее отбрасывается, письмо при этом регистрируется:
  // терять входящее из-за раздутого вложения хуже, чем принять его без файла —
  // оригинал остаётся в ящике, а счётчик отброшенного виден в очереди
  const attachments: LetterAttachment[] = []
  let total = 0
  for (const item of candidates) {
    if (attachments.length >= MAX_ATTACHMENTS) break
    if (item.content.length > MAX_ATTACHMENT_BYTES) continue
    if (total + item.content.length > MAX_ATTACHMENTS_BYTES) continue
    total += item.content.length
    attachments.push(item)
  }

  return {
    messageId: unwrap(mail.messageId),
    fromEmail: (from?.address ?? '').toLowerCase(),
    fromName: from?.name?.trim() ? from.name.trim() : null,
    toEmail: to?.address?.toLowerCase() ?? null,
    subject: (mail.subject ?? '').trim(),
    body,
    sentAt: mail.date ? mail.date.toISOString() : null,
    inReplyTo: unwrap(mail.inReplyTo) || null,
    references: references.map(unwrap).filter(Boolean),
    attachments,
    skippedAttachments: candidates.length - attachments.length,
  }
}

/**
 * Ключ дедупликации. `Message-ID` уникален по определению; письма без него
 * (редкость, но встречается у шлюзов) опознаются по месту в ящике — папка
 * и UID с меткой её поколения.
 */
export function messageKeyOf(
  letter: Pick<ParsedLetter, 'messageId'>,
  mailbox: { uid: number | null; uidValidity: string | null },
): string {
  if (letter.messageId) return letter.messageId.slice(0, 500)
  return `uid:${mailbox.uidValidity ?? '0'}:${mailbox.uid ?? 0}`
}

function contains(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase().trim()))
}

/**
 * Правила отбора: пустой список ничего не ограничивает, заполненный требует
 * совпадения хотя бы с одной строкой. Причина отказа возвращается словом —
 * она попадает в журнал синхронизаций, а не теряется.
 */
export function letterRejection(
  letter: Pick<ParsedLetter, 'fromEmail' | 'fromName' | 'subject' | 'attachments'>,
  filters: MailboxFilters,
): string | null {
  const from = `${letter.fromEmail} ${letter.fromName ?? ''}`
  if (filters.fromExcludes.length > 0 && contains(from, filters.fromExcludes)) {
    return 'отправитель в списке исключений'
  }
  if (filters.fromContains.length > 0 && !contains(from, filters.fromContains)) {
    return 'отправитель не подходит под правила отбора'
  }
  if (filters.subjectContains.length > 0 && !contains(letter.subject, filters.subjectContains)) {
    return 'тема не подходит под правила отбора'
  }
  if (filters.requireAttachment && letter.attachments.length === 0) {
    return 'письмо без вложений'
  }
  return null
}

/** Тема письма в тему документа: пустую заменяем отправителем. */
export function subjectOf(letter: Pick<ParsedLetter, 'subject' | 'fromEmail'>): string {
  const subject = letter.subject.trim()
  if (subject.length > 0) return subject.slice(0, 1000)
  return `Письмо от ${letter.fromEmail || 'неизвестного отправителя'}`.slice(0, 1000)
}
