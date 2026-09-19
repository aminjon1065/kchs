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
