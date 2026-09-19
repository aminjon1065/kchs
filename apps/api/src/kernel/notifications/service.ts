import {
  type DeliveryMode,
  type Locale,
  NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import { type Database, db } from '~/shared/db/client.js'
import { notificationPreferences, notifications, users } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { mailConfigured, sendMail } from '~/shared/mail/index.js'
import { redactSummary } from '../access/confidentiality.js'
import { directory } from '../directory/port.js'
import { InboxService } from '../inbox/service.js'
import { ObjectService } from '../objects/service.js'
import { emitToUser } from '../realtime/gateway.js'
import {
  availableChannels,
  EXTERNAL_CHANNELS,
  type ExternalChannel,
  notificationChannel,
} from './channels.js'

/** Окно агрегации: несколько событий одного объекта сливаются в одно уведомление. */
const AGGREGATE_WINDOW_MINUTES = 5

export interface NotifyInput {
  userIds: string[]
  category: NotificationCategory
  titleKey: string
  params?: Record<string, unknown>
  objectId?: string | null
  actorId?: string | null
  url?: string | null
  /** Ключ агрегации; по умолчанию — категория + объект. */
  aggregateKey?: string | null
  channels?: NotificationChannel[]
}

export const NotificationService = {
  /**
   * Конвейер: правило → агрегация/дедупликация → доставка по каналам
   * (02-platform-kernel.md §7).
   */
  async notify(input: NotifyInput): Promise<void> {
    const recipients = [...new Set(input.userIds)].filter((id) => id && !id.startsWith('link:'))
    if (recipients.length === 0) return

    const aggregateKey =
      input.aggregateKey ?? `${input.category}:${input.objectId ?? 'none'}:${input.titleKey}`
    // Внешние каналы (Telegram) — только у тех, кому они доступны: привязан аккаунт
    const external = await availableChannels(recipients)

    for (const userId of recipients) {
      // Не уведомляем автора о его же действии
      if (input.actorId && input.actorId === userId) continue

      const modes = await resolveChannels(
        userId,
        input.category,
        input.channels,
        external.get(userId),
      )
      const channels = Object.keys(modes) as NotificationChannel[]
      if (channels.length === 0) continue

      const [existing] = await db()
        .select({ id: notifications.id, count: notifications.aggregateCount })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.aggregateKey, aggregateKey),
            isNull(notifications.readAt),
            sql`${notifications.createdAt} > now() - make_interval(mins => ${AGGREGATE_WINDOW_MINUTES})`,
          ),
        )
        .limit(1)

      if (existing) {
        await db()
          .update(notifications)
          .set({ aggregateCount: existing.count + 1, createdAt: sql`now()` })
          .where(eq(notifications.id, existing.id))
        emitToUser(userId, 'notification.new', { aggregated: true, id: String(existing.id) })
        continue
      }

      const [row] = await db()
        .insert(notifications)
        .values({
          userId,
          category: input.category,
          titleKey: input.titleKey,
          params: (input.params ?? {}) as Record<string, unknown>,
          objectId: input.objectId ?? null,
          actorId: input.actorId ?? null,
          url: input.url ?? null,
          channels,
          aggregateKey,
        })
        .returning({ id: notifications.id })

      emitToUser(userId, 'notification.new', { id: String(row?.id ?? '') })

      // E-mail: «немедленно» уходит сразу, «дайджест» — заданием по расписанию.
      // Ошибка почты не ломает уведомление: оно останется в очереди дайджеста.
      if (modes.email === 'immediate' && row) {
        try {
          await deliverEmail([row.id])
        } catch (error) {
          logger().error({ err: error, userId }, 'не удалось отправить уведомление почтой')
        }
      }

      // Внешние каналы доставляют сразу: дайджеста у них нет, слитые повторы не
      // отправляются (как и письма) — иначе мессенджер получал бы каждое изменение
      const immediate = EXTERNAL_CHANNELS.filter((channel) => modes[channel] !== undefined)
      if (row && immediate.length > 0) {
        try {
          await deliverExternal(row.id, immediate)
        } catch (error) {
          logger().error(
            { err: error, userId },
            'не удалось доставить уведомление во внешний канал',
          )
        }
      }
    }
  },

  async list(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<{ items: Notification[]; nextCursor: string | null; unread: number }> {
    const limit = Math.min(options.limit ?? 30, 100)
    const conditions = [eq(notifications.userId, userId)]
    if (options.unreadOnly) conditions.push(isNull(notifications.readAt))
    if (options.cursor) conditions.push(sql`${notifications.id} < ${Number(options.cursor)}`)

    const rows = await db()
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const [locale, unread] = await Promise.all([
      localeOf(userId),
      NotificationService.unreadCount(userId),
    ])
    const t = createTranslator(locale)

    const objectIds = page.map((r) => r.objectId).filter((v): v is string => Boolean(v))
    const summaries = await ObjectService.summaries([...new Set(objectIds)])
    const actorIds = page.map((r) => r.actorId).filter((v): v is string => Boolean(v))
    const actors = await directory().refs([...new Set(actorIds)])

    return {
      items: page.map((row) => {
        // Объект с грифом от «конфиденциально» — без содержания (08-documents.md §13)
        const found = row.objectId ? summaries.get(row.objectId) : undefined
        const summary = found ? redactSummary(found, locale) : null
        const actor = row.actorId ? (actors.get(row.actorId) ?? null) : null
        const params = {
          // Имя автора — для «{actor} упомянул вас…», как при доставке почтой и в Telegram
          ...(actor ? { actor: actor.displayName } : {}),
          ...(row.params as Record<string, string>),
          count: row.aggregateCount,
          title: summary?.title ?? (row.params as { title?: string }).title ?? '',
        }
        return {
          id: String(row.id),
          category: row.category as NotificationCategory,
          title:
            row.aggregateCount > 1 ? t('notifications.aggregate', params) : t(row.titleKey, params),
          body: null,
          object: summary,
          actor,
          url: row.url ?? summary?.url ?? null,
          aggregateCount: row.aggregateCount,
          readAt: row.readAt,
          createdAt: row.createdAt,
        }
      }),
      nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
      unread,
    }
  },

  async unreadCount(userId: string): Promise<number> {
    const [row] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    return row?.count ?? 0
  },

  async markRead(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db()
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.userId, userId),
          inArray(
            notifications.id,
            ids.map((id) => Number(id)),
          ),
        ),
      )
  },

  async markAllRead(userId: string): Promise<void> {
    await db()
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  },

  async preferences(userId: string, database: Database = db()): Promise<NotificationPreferences> {
    const rows = await database
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
    return {
      items: rows.map((row) => ({
        category: row.category as NotificationCategory,
        channel: row.channel as NotificationChannel,
        mode: row.mode as DeliveryMode,
      })),
      defaults: NOTIFICATION_CATEGORIES.flatMap((category) =>
        (['app', 'email', 'telegram'] as const).map((channel) => ({
          category,
          channel,
          mode: DEFAULT_MODES[category]?.[channel] ?? 'off',
        })),
      ),
      quietHours: null,
      doNotDisturbUntil: null,
      digestHour: 8,
    }
  },

  async setPreference(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    mode: DeliveryMode,
  ): Promise<void> {
    await db()
      .insert(notificationPreferences)
      .values({ userId, category, channel, mode })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.category,
          notificationPreferences.channel,
        ],
        set: { mode },
      })
  },
}

/**
 * Правила по умолчанию (12-calendar-notifications-home.md §2): действия и
 * упоминания — во все каналы, включая Telegram; остальное в Telegram — по выбору.
 * Поручения и задачи — тоже действия: назначение и отчёт приходят в Telegram сразу.
 */
const DEFAULT_MODES: Record<string, Partial<Record<NotificationChannel, DeliveryMode>>> = {
  inbox: { app: 'immediate', email: 'immediate', telegram: 'immediate' },
  mention: { app: 'immediate', email: 'immediate', telegram: 'immediate' },
  discussion: { app: 'immediate', email: 'digest' },
  object: { app: 'immediate', email: 'off' },
  tasks: { app: 'immediate', email: 'digest', telegram: 'immediate' },
  documents: { app: 'immediate', email: 'digest' },
  chat: { app: 'immediate', email: 'off' },
  meetings: { app: 'immediate', email: 'immediate', telegram: 'immediate' },
  calendar: { app: 'immediate', email: 'digest' },
  data: { app: 'immediate', email: 'digest' },
  system: { app: 'immediate', email: 'digest' },
}

const isExternal = (channel: NotificationChannel): channel is ExternalChannel =>
  (EXTERNAL_CHANNELS as readonly string[]).includes(channel)

async function resolveChannels(
  userId: string,
  category: NotificationCategory,
  requested: NotificationChannel[] | undefined,
  available: Set<ExternalChannel> | undefined,
): Promise<Partial<Record<NotificationChannel, DeliveryMode>>> {
  const prefs = await db()
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.category, category),
      ),
    )

  const defaults = DEFAULT_MODES[category] ?? { app: 'immediate' }
  const result: Partial<Record<NotificationChannel, DeliveryMode>> = {}
  const candidates = requested ?? (['app', 'email', 'telegram', 'push'] as NotificationChannel[])

  for (const channel of candidates) {
    if (isExternal(channel) && !available?.has(channel)) continue
    const override = prefs.find((p) => p.channel === channel)?.mode as DeliveryMode | undefined
    const mode = override ?? defaults[channel] ?? 'off'
    if (mode !== 'off') result[channel] = mode
  }
  return result
}

async function localeOf(userId: string): Promise<Locale> {
  const [row] = await db()
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return (row?.locale as Locale) ?? 'ru'
}

/** Адрес веб-клиента без завершающей косой черты: к нему дописывается путь `/o/{id}`. */
const baseUrl = () => config().KCHS_BASE_URL.replace(/\/+$/, '')

/** Поля уведомления, из которых собираются текст и ссылка. */
interface RenderSource {
  id: number
  titleKey: string
  params: Record<string, unknown>
  objectId: string | null
  actorId: string | null
  url: string | null
  aggregateCount: number
  locale: string | null
}

/**
 * Текст уведомления на языке получателя и абсолютная ссылка, открывающая
 * вкладку объекта, — одни для писем и внешних каналов (ADR-0061).
 */
async function renderForDelivery(
  rows: RenderSource[],
): Promise<Map<number, { text: string; href: string }>> {
  const base = baseUrl()
  const summaries = await ObjectService.summaries([
    ...new Set(rows.map((r) => r.objectId).filter((v): v is string => Boolean(v))),
  ])
  // Имя автора — для «{actor} упомянул вас…»: в параметрах уведомления его нет
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => Boolean(v)))]
  const actors = new Map(
    actorIds.length > 0
      ? (
          await db()
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, actorIds))
        ).map((row) => [row.id, row.name])
      : [],
  )

  const result = new Map<number, { text: string; href: string }>()
  for (const row of rows) {
    const locale = (row.locale as Locale | null) ?? 'ru'
    const t = createTranslator(locale)
    // Письма и Telegram по объекту с грифом — только «Документ № …» (08-documents.md §13)
    const found = row.objectId ? summaries.get(row.objectId) : undefined
    const summary = found ? redactSummary(found, locale) : null
    const params = {
      ...(row.actorId && actors.has(row.actorId) ? { actor: actors.get(row.actorId) } : {}),
      ...(row.params as Record<string, string>),
      count: row.aggregateCount,
      title: summary?.title ?? (row.params as { title?: string }).title ?? '',
    }
    const text =
      row.aggregateCount > 1 ? t('notifications.aggregate', params) : t(row.titleKey, params)
    result.set(row.id, { text, href: `${base}${row.url ?? summary?.url ?? '/'}` })
  }
  return result
}

/**
 * Доставка нового уведомления во внешние каналы получателя (Telegram): текст —
 * на его языке, ссылка открывает вкладку объекта.
 */
async function deliverExternal(id: number, channels: ExternalChannel[]): Promise<void> {
  const [row] = await db()
    .select({
      id: notifications.id,
      userId: notifications.userId,
      category: notifications.category,
      titleKey: notifications.titleKey,
      params: notifications.params,
      objectId: notifications.objectId,
      actorId: notifications.actorId,
      url: notifications.url,
      aggregateCount: notifications.aggregateCount,
      locale: users.locale,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.id, id))
    .limit(1)
  if (!row) return
  const rendered = (await renderForDelivery([row])).get(row.id)
  if (!rendered) return
  // Кнопки дел получателя по объекту: «Принять», «Отчитаться», «Продлить» (ADR-0082)
  const actions = row.objectId ? await InboxService.openActions(row.userId, row.objectId) : []
  for (const channel of channels) {
    await notificationChannel(channel)?.deliver([
      {
        notificationId: row.id,
        userId: row.userId,
        locale: (row.locale as Locale | null) ?? 'ru',
        category: row.category as NotificationCategory,
        text: rendered.text,
        url: rendered.href,
        actions: actions.map((action) => ({
          itemId: action.itemId,
          key: action.key,
          labelKey: action.labelKey,
          requiresComment: action.requiresComment,
          input: action.input,
        })),
      },
    ])
  }
}

/**
 * Доставка уведомлений почтой: письмо по одному (немедленно) или дайджест
 * (02-platform-kernel.md §7). Уже отправленные пропускаются.
 */
export async function deliverEmail(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0

  const rows = await db()
    .select({
      id: notifications.id,
      userId: notifications.userId,
      titleKey: notifications.titleKey,
      params: notifications.params,
      objectId: notifications.objectId,
      actorId: notifications.actorId,
      url: notifications.url,
      aggregateCount: notifications.aggregateCount,
      createdAt: notifications.createdAt,
      email: users.email,
      locale: users.locale,
      displayName: users.displayName,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        inArray(notifications.id, ids),
        isNull(notifications.emailedAt),
        isNull(notifications.readAt),
        sql`${notifications.channels} @> '["email"]'::jsonb`,
      ),
    )

  if (rows.length === 0) return 0

  const byUser = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? []
    list.push(row)
    byUser.set(row.userId, list)
  }

  const base = baseUrl()
  const rendered = await renderForDelivery(rows)

  let sent = 0
  for (const [, items] of byUser) {
    const first = items[0]
    if (!first?.email) continue

    const t = createTranslator((first.locale as Locale) ?? 'ru')
    const lines = items.map((row) => {
      const { text, href } = rendered.get(row.id) ?? { text: '', href: base }
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(text)}</a></li>`
    })

    const subject =
      items.length === 1
        ? t('notifications.title')
        : `${t('notifications.title')} — ${items.length}`

    const delivered = await sendMail({
      to: first.email,
      subject,
      html: `<p>${escapeHtml(first.displayName)},</p><ul>${lines.join('')}</ul><p><a href="${escapeHtml(base)}">${escapeHtml(base)}</a></p>`,
    })

    // Без SMTP письма не уходят — помечать нечего, дайджест повторится позже
    if (!delivered) continue

    await db()
      .update(notifications)
      .set({ emailedAt: sql`now()` })
      .where(
        inArray(
          notifications.id,
          items.map((row) => row.id),
        ),
      )
    sent += items.length
  }
  return sent
}

/**
 * Дайджест: всё, что накопилось с канала `email` и ещё не отправлено.
 * Вызывается заданием обслуживания по расписанию.
 */
export async function sendEmailDigest(olderThanMinutes = 5): Promise<number> {
  if (!mailConfigured()) return 0

  const pending = await db()
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        isNull(notifications.emailedAt),
        isNull(notifications.readAt),
        sql`${notifications.channels} @> '["email"]'::jsonb`,
        sql`${notifications.createdAt} < now() - make_interval(mins => ${olderThanMinutes})`,
      ),
    )
    .limit(1000)

  return deliverEmail(pending.map((row) => row.id))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
