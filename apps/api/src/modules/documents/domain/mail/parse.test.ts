import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MailboxFilters } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  attachmentName,
  htmlToText,
  letterRejection,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  messageKeyOf,
  parseLetter,
  subjectOf,
} from './parse.js'

/**
 * Разбор письма канцелярии (ADR-0113) на настоящих письмах: тема и имя файла в
 * MIME-кодировке, текстовая и html-части, вложения против встроенных картинок
 * подписи, письмо без `Message-ID`.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const letter = (name: string) => readFileSync(path.join(fixtures, name))

const filters = (patch: Partial<MailboxFilters> = {}) => MailboxFilters.parse(patch)

describe('разбор письма', () => {
  it('читает отправителя, тему и текст простого письма', async () => {
    const parsed = await parseLetter(letter('simple.eml'))

    expect(parsed.messageId).toBe('2026-0917-1042@mvd.example.tj')
    expect(parsed.fromEmail).toBe('kanc@mvd.example.tj')
    expect(parsed.fromName).toBe('Канцелярия МВД')
    expect(parsed.toEmail).toBe('office@kchs.example.tj')
    expect(parsed.subject).toBe('О проведении совместных учений')
    expect(parsed.body).toContain('Просим согласовать дату совместных учений')
    expect(parsed.sentAt?.slice(0, 10)).toBe('2026-09-17')
    expect(parsed.attachments).toHaveLength(0)
  })

  it('берёт вложение, а встроенную картинку подписи — нет', async () => {
    const parsed = await parseLetter(letter('with-attachment.eml'))

    expect(parsed.subject).toBe('Донесение о паводке')
    // Текста не было — в карточку идёт html, приведённый к тексту
    expect(parsed.body).toContain('Направляем донесение о паводке')
    expect(parsed.body).not.toContain('<b>')
    expect(parsed.attachments.map((item) => item.name)).toEqual(['Донесение №77.pdf'])
    expect(parsed.attachments[0]?.mime).toBe('application/pdf')
    expect(parsed.attachments[0]?.content.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('письмо без Message-ID опознаётся по месту в ящике', async () => {
    const parsed = await parseLetter(letter('bare.eml'))

    expect(parsed.messageId).toBe('')
    expect(messageKeyOf(parsed, { uid: 42, uidValidity: '17' })).toBe('uid:17:42')
    // А у письма с заголовком ключ — сам заголовок, и он одинаков в обоих ящиках
    const withId = await parseLetter(letter('simple.eml'))
    expect(messageKeyOf(withId, { uid: 1, uidValidity: '1' })).toBe(
      messageKeyOf(withId, { uid: 2, uidValidity: '9' }),
    )
  })

  it('тему пустого письма заменяет отправитель', async () => {
    const parsed = await parseLetter(letter('bare.eml'))
    expect(subjectOf(parsed)).toBe('Письмо от noreply@rassylka.example.org')
  })
})

describe('правила отбора писем', () => {
  const sample = {
    fromEmail: 'kanc@mvd.example.tj',
    fromName: 'Канцелярия МВД',
    subject: 'О проведении совместных учений',
    attachments: [] as Array<{ name: string; mime: string; content: Buffer }>,
  }

  it('пустые правила пропускают всё', () => {
    expect(letterRejection(sample, filters())).toBeNull()
  })

  it('отправитель и тема должны совпасть хотя бы с одной строкой', () => {
    expect(letterRejection(sample, filters({ fromContains: ['mvd.example.tj'] }))).toBeNull()
    expect(letterRejection(sample, filters({ fromContains: ['@mchs.tj'] }))).toContain(
      'отправитель',
    )
    expect(letterRejection(sample, filters({ subjectContains: ['учени'] }))).toBeNull()
    expect(letterRejection(sample, filters({ subjectContains: ['счёт'] }))).toContain('тема')
  })

  it('исключения отсекают рассылки, а требование вложения — письма без файлов', () => {
    expect(letterRejection(sample, filters({ fromExcludes: ['noreply'] }))).toBeNull()
    expect(
      letterRejection(
        { ...sample, fromEmail: 'noreply@x.tj' },
        filters({ fromExcludes: ['noreply'] }),
      ),
    ).toContain('исключений')
    expect(letterRejection(sample, filters({ requireAttachment: true }))).toContain('вложений')
  })
})

describe('имя вложения', () => {
  it('убирает пути и управляющие символы, пустое заменяет номером', () => {
    expect(attachmentName('../../etc/passwd', 0)).toBe('.._.._etc_passwd')
    expect(attachmentName('акт\u0007.pdf', 0)).toBe('акт.pdf')
    expect(attachmentName(undefined, 2)).toBe('Вложение 3')
  })
})

/**
 * Письмо приходит снаружи и кладётся в хранилище целиком, поэтому пределы нужны
 * здесь, а не только у формы загрузки (17-security.md §5). Письмо при этом не
 * теряется: оно регистрируется без отброшенных файлов, а оригинал остаётся в
 * ящике.
 */
describe('пределы вложений', () => {
  const build = (parts: { name: string; size: number }[]) =>
    Buffer.from(
      [
        'From: Отправитель <sender@example.org>',
        'To: office@kchs.example.tj',
        'Subject: Тяжёлое письмо',
        'Message-ID: <heavy@example.org>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        'Текст',
        ...parts.flatMap((part) => [
          '--b',
          'Content-Type: application/octet-stream',
          `Content-Disposition: attachment; filename="${part.name}"`,
          '',
          'x'.repeat(part.size),
          '',
        ]),
        '--b--',
        '',
      ].join('\r\n'),
    )

  it('слишком большое вложение отбрасывается, письмо остаётся с остальными', async () => {
    const parsed = await parseLetter(
      build([
        { name: 'огромное.bin', size: MAX_ATTACHMENT_BYTES + 1 },
        { name: 'акт.pdf', size: 16 },
      ]),
    )
    expect(parsed.attachments.map((item) => item.name)).toEqual(['акт.pdf'])
    expect(parsed.skippedAttachments).toBe(1)
    expect(parsed.subject).toBe('Тяжёлое письмо')
  })

  it('число вложений ограничено', async () => {
    const parts = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, index) => ({
      name: `файл-${index}.bin`,
      size: 8,
    }))
    const parsed = await parseLetter(build(parts))
    expect(parsed.attachments).toHaveLength(MAX_ATTACHMENTS)
    expect(parsed.skippedAttachments).toBe(3)
  })
})

describe('html в текст', () => {
  it('сохраняет абзацы и разворачивает мнемоники', () => {
    expect(htmlToText('<p>Первый</p><p>Второй &amp; третий</p>')).toBe('Первый\nВторой & третий')
    expect(htmlToText('<style>p{}</style><p>Текст</p>')).toBe('Текст')
  })
})
