import { PRODUCT_NAME } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import webpush, { WebPushError } from 'web-push'
import type { ChannelMessage } from '~/kernel/notifications/channels.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { pushSubscriptions } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'

/**
 * Push-уведомления (Web Push, ADR-0094): сообщение шифруется ключами
 * устройства и уходит в службу доставки браузера (FCM, Mozilla, Apple).
 * Сервер знает только адрес подписки и ключи — содержимое службе недоступно.
 * Без ключей VAPID функция выключена.
 */
export interface PushConfig {
  publicKey: string
  privateKey: string
  contact: string
}

export function pushConfig(): PushConfig | null {
  const env = config()
  const publicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.PUSH_VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey) return null
  const contact = env.PUSH_CONTACT?.trim() || 'mailto:admin@example.org'
  return { publicKey, privateKey, contact }
}

export interface DeviceInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
  userAgent?: string | null
}

export const PushService = {
  /** Подписка устройства: повторная с тем же адресом переезжает на текущего пользователя. */
  async subscribe(ctx: UserCtx, input: DeviceInput): Promise<{ id: string }> {
    const [row] = await db()
      .insert(pushSubscriptions)
      .values({
        id: newId(),
        userId: ctx.userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: ctx.userId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
        },
      })
      .returning({ id: pushSubscriptions.id })
    return { id: row?.id ?? '' }
  },

  /** Отписка этого устройства (адрес знает только оно). */
  async unsubscribe(ctx: UserCtx, endpoint: string): Promise<boolean> {
    const removed = await db()
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.userId, ctx.userId), eq(pushSubscriptions.endpoint, endpoint)),
      )
      .returning({ id: pushSubscriptions.id })
    return removed.length > 0
  },

  /** Сколько устройств подписано — профиль показывает состояние. */
  async deviceCount(userId: string): Promise<number> {
    const [row] = await db()
      .select({ total: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
    return row?.total ?? 0
  },

  /** Кому push доступен: у кого есть хотя бы одно устройство. */
  async subscribed(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set()
    const rows = await db()
      .selectDistinct({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds))
    return new Set(rows.map((row) => row.userId))
  },

  /**
   * Доставка уведомления на все устройства получателя. Устройство, о котором
   * служба доставки сказала «нет такого» (404/410), удаляется.
   */
  async deliver(messages: ChannelMessage[]): Promise<void> {
    const push = pushConfig()
    if (!push || messages.length === 0) return
    const log = logger().child({ module: 'push' })
    const userIds = [...new Set(messages.map((message) => message.userId))]
    const devices = await db()
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds))
    const byUser = new Map<string, typeof devices>()
    for (const device of devices) {
      byUser.set(device.userId, [...(byUser.get(device.userId) ?? []), device])
    }
    const expired: string[] = []
    for (const message of messages) {
      const payload = JSON.stringify({
        title: PRODUCT_NAME,
        body: message.text,
        url: message.url,
        category: message.category,
        notificationId: message.notificationId,
      })
      for (const device of byUser.get(message.userId) ?? []) {
        try {
          await webpush.sendNotification(
            {
              endpoint: device.endpoint,
              keys: { p256dh: device.p256dh, auth: device.auth },
            },
            payload,
            {
              vapidDetails: {
                subject: push.contact,
                publicKey: push.publicKey,
                privateKey: push.privateKey,
              },
              TTL: 3600,
            },
          )
        } catch (error) {
          const status = error instanceof WebPushError ? error.statusCode : 0
          if (status === 404 || status === 410) expired.push(device.id)
          else log.warn({ err: error, endpoint: device.endpoint }, 'push не доставлен')
        }
      }
    }
    if (expired.length > 0) {
      await db().delete(pushSubscriptions).where(inArray(pushSubscriptions.id, expired))
      log.info({ count: expired.length }, 'подписки push сняты службой доставки')
    }
    const sent = messages.map((message) => message.userId)
    if (sent.length > 0) {
      await db()
        .update(pushSubscriptions)
        .set({ lastSentAt: sql`now()` })
        .where(inArray(pushSubscriptions.userId, sent))
    }
  },
}
