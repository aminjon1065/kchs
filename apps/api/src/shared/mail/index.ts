import type { Readable } from 'node:stream'
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

/**
 * Единственная точка отправки почты. Без `SMTP_URL` письма не отправляются,
 * а пишутся в журнал — нормальный режим разработки и офлайн-установки.
 */
let transporter: Transporter | null = null

function mailer(): Transporter | null {
  const url = config().SMTP_URL
  if (!url) return null
  if (!transporter) transporter = nodemailer.createTransport(url)
  return transporter
}

/** Сброс транспорта после смены SMTP_URL (тесты, смена настроек). */
export function resetMailer(): void {
  transporter?.close()
  transporter = null
}

export function mailConfigured(): boolean {
  return Boolean(config().SMTP_URL)
}

export interface MailAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export interface MailMessage {
  to: string
  subject: string
  html: string
  text?: string
  /** Вложения (отчёт по расписанию, ADR-0078). */
  attachments?: MailAttachment[]
}

/** `true` — письмо передано транспорту; `false` — SMTP не настроен. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const transport = mailer()
  if (!transport) {
    logger().debug({ to: message.to, subject: message.subject }, 'письмо не отправлено: нет SMTP')
    return false
  }
  await transport.sendMail({
    from: config().SMTP_FROM,
    to: message.to,
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  })
  return true
}

/** Письмо от имени организации — исходящий документ (ADR-0149). */
export interface OutgoingMail {
  from: string
  replyTo?: string
  to: string
  subject: string
  text: string
  html: string
  /** Свой Message-ID: по нему уведомление о недоставке находит письмо. */
  messageId: string
  attachments: Array<{ filename: string; content: Readable | Buffer; contentType: string }>
}

export interface MailReceipt {
  messageId: string
  accepted: string[]
  rejected: string[]
  response: string
}

/**
 * Отправка с квитанцией сервера: кого он принял и кого отклонил сразу. `null` — SMTP не
 * настроен. Ошибку соединения и отказ сервера целиком бросает транспорт.
 */
export async function sendMailWithReceipt(message: OutgoingMail): Promise<MailReceipt | null> {
  const transport = mailer()
  if (!transport) return null
  const info = await transport.sendMail({
    from: message.from,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId: message.messageId,
    attachments: message.attachments,
  })
  const addresses = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.map((item) => (typeof item === 'string' ? item : String(item?.address ?? item)))
      : []
  return {
    messageId: String(info.messageId ?? message.messageId),
    accepted: addresses(info.accepted),
    rejected: addresses(info.rejected),
    response: String(info.response ?? ''),
  }
}

/** Адрес отправителя без имени: `Канцелярия <kanc@kchs.test>` → `kanc@kchs.test`. */
export function mailAddressOf(from: string): string {
  const match = /<([^>]+)>/.exec(from)
  return (match?.[1] ?? from).trim()
}

/**
 * Проверка соединения с почтовым сервером для кнопки «Проверить соединение»
 * (14-automation-integrations.md §5, ADR-0097). Адрес сервера и пароль в
 * сообщение не попадают — только исход проверки.
 */
export async function verifyMail(): Promise<{ ok: boolean; message: string }> {
  const transport = mailer()
  if (!transport) return { ok: false, message: 'SMTP не настроен: задайте SMTP_URL' }
  try {
    await transport.verify()
    return { ok: true, message: 'Соединение установлено' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Ошибка соединения' }
  }
}
