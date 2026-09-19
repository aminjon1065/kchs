import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  type Locale,
  REPORT_CONTENT_TYPES,
  type ReportDeliveryChannel,
  type ReportDeliveryStatus,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { eq } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { notificationChannel } from '~/kernel/notifications/channels.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { buckets, s3 } from '~/kernel/storage/s3.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, users } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { sendMail } from '~/shared/mail/index.js'
import { ReportRuns, type StoredRunFile } from './run-service.js'

/**
 * Файл больше этого не вкладывается в письмо и не отправляется ботом: в письме
 * и сообщении остаётся ссылка на отчёт (история запусков, скачивание по правам).
 */
const ATTACH_LIMIT_BYTES = 20 * 1024 * 1024

async function readFile(file: StoredRunFile): Promise<Buffer | null> {
  if (file.size > ATTACH_LIMIT_BYTES) return null
  const response = await s3().send(
    new GetObjectCommand({ Bucket: buckets.exports(), Key: file.key }),
  )
  const bytes = await response.Body?.transformToByteArray()
  return bytes ? Buffer.from(bytes) : null
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Доставка готового отчёта (P2-E05 S05, ADR-0078) — подписчик `report.generated`
 * в роли worker. «Сформировать» — уведомление нажавшему; расписание — по каналам
 * запуска его получателю: элемент Входящих, письмо с файлом, документ от бота
 * Telegram. Итог по каналам пишется в запуск и событие `report.delivered`.
 */
export const ReportDelivery = {
  async deliver(runId: string): Promise<void> {
    const found = await ReportRuns.files(runId)
    if (found?.row.status !== 'succeeded') return
    const { row, files } = found
    const [object] = await db()
      .select({ title: objects.title, spaceId: objects.spaceId })
      .from(objects)
      .where(eq(objects.id, row.reportId))
      .limit(1)
    const title = object?.title ?? ''
    const ctx = systemCtx('report.delivery', { initiatorId: row.runAs })

    if (row.trigger === 'manual') {
      await NotificationService.notify({
        userIds: [row.runAs],
        category: 'data',
        titleKey: 'data.report.notifications.ready',
        params: { title },
        objectId: row.reportId,
        actorId: null,
      })
      return
    }

    const channels = row.channels as ReportDeliveryChannel[]
    // Повтор подписчика: доставка уже записана — второй раз не отправляем
    if (channels.length === 0 || Object.keys(row.delivery).length > 0) return

    const [user] = await db()
      .select({ email: users.email, locale: users.locale, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.runAs))
      .limit(1)
    if (!user) return
    const locale = (user.locale as Locale | null) ?? 'ru'
    const t = createTranslator(locale)
    const url = `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/o/${row.reportId}`
    const caption = t('data.report.delivery.caption', { title })
    const results: Partial<Record<ReportDeliveryChannel, ReportDeliveryStatus>> = {}

    const needsFiles = channels.includes('email') || channels.includes('telegram')
    const contents = new Map<StoredRunFile, Buffer | null>()
    if (needsFiles) {
      for (const file of files) {
        try {
          contents.set(file, await readFile(file))
        } catch (error) {
          logger().warn(
            { err: error, runId, key: file.key },
            'файл отчёта не прочитан для рассылки',
          )
          contents.set(file, null)
        }
      }
    }
    const attachable = files.filter((file) => contents.get(file))

    if (channels.includes('email')) {
      if (!user.email) {
        results.email = 'unavailable'
      } else {
        try {
          const sent = await sendMail({
            to: user.email,
            subject: t('data.report.delivery.subject', { title }),
            html: `<p>${escapeHtml(user.displayName)},</p><p>${escapeHtml(caption)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
            attachments: attachable.map((file) => ({
              filename: file.fileName,
              content: contents.get(file) as Buffer,
              contentType: REPORT_CONTENT_TYPES[file.format],
            })),
          })
          results.email = sent ? 'sent' : 'unavailable'
        } catch (error) {
          logger().warn({ err: error, runId }, 'отчёт не отправлен почтой')
          results.email = 'failed'
        }
      }
    }

    if (channels.includes('telegram')) {
      const telegram = notificationChannel('telegram')
      if (!telegram?.sendDocument || attachable.length === 0) {
        results.telegram = 'unavailable'
      } else {
        let outcome: ReportDeliveryStatus = 'sent'
        for (const file of attachable) {
          const sent = await telegram.sendDocument({
            userId: row.runAs,
            fileName: file.fileName,
            contentType: REPORT_CONTENT_TYPES[file.format],
            content: contents.get(file) as Buffer,
            caption,
            url,
            locale,
          })
          if (sent !== 'sent') {
            outcome = sent
            break
          }
        }
        results.telegram = outcome
      }
    }

    await db().transaction(async (tx) => {
      if (channels.includes('inbox')) {
        await InboxService.open(tx, ctx, {
          userId: row.runAs,
          kind: 'report',
          objectId: row.reportId,
          titleKey: 'data.report.inbox.ready',
          params: { title },
          payload: { runId },
          dedupeKey: `report:${runId}`,
          actions: [
            {
              key: 'acknowledge',
              labelKey: 'inbox.actions.acknowledge',
              variant: 'primary',
              requiresComment: false,
            },
          ],
        })
        results.inbox = 'sent'
      }
      await ReportRuns.recordDelivery(tx, runId, results)
      await publishEvent(tx, ctx, {
        type: 'report.delivered',
        object: object
          ? { id: row.reportId, type: 'report', spaceId: object.spaceId, title }
          : null,
        payload: { runId, userId: row.runAs, channels: results },
      })
    })
  },
}
