import { createHash } from 'node:crypto'
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
import { logger } from '~/shared/logger/index.js'
import { mailConfigured, sendMail } from '~/shared/mail/index.js'
import { redactSummary } from '../access/confidentiality.js'
import { serviceAccountIds } from '../access/service-accounts.js'
import { directory } from '../directory/port.js'
import { users } from '../directory/schema.js'
import { currentEventDelivery } from '../events/delivery.js'
import { type InboxOpenAction, InboxService } from '../inbox/service.js'
import { ObjectService } from '../objects/service.js'
import { emitToUser } from '../realtime/gateway.js'
import {
  availableChannels,
  type ChannelMessage,
  EXTERNAL_CHANNELS,
  type ExternalChannel,
  notificationChannel,
} from './channels.js'
import { quietRecipients } from './quiet.js'
import { notificationPreferences, notifications } from './schema.js'

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
  /**
   * Каналы выбраны явно (действие правила «Отправить в Telegram»): запрошенные каналы
   * доставляются сразу, минуя режимы категории по умолчанию; снимает канал только явное
   * «выключено» пользователя в этой категории. Тишину получателя это не отменяет.
   */
  direct?: boolean
  /**
   * Срочное (05-risks N23, ADR-0140): алерты, эскалации, срочные поручения, напоминание о
   * встрече и входящий звонок. Проходит сквозь тишину получателя — «не беспокоить», тихие
   * часы, встречу; запрошенные каналы доставляются сразу, как у `direct`.
   */
  urgent?: boolean
  /**
   * Ключ повтора (ADR-0171). В подписчике события задаётся сам — из подписчика, события и
   * содержания уведомления; вызов вне обработки события (задание с повторами) может
   * передать свой. Уведомление с тем же ключом получатель второй раз не получит.
   */
  dedupeKey?: string | null
}

export const NotificationService = {
  /**
   * Конвейер: правило → агрегация/дедупликация → доставка по каналам
   * (02-platform-kernel.md §7).
   */
  async notify(input: NotifyInput): Promise<void> {
    const addressed = [...new Set(input.userIds)].filter((id) => id && !id.startsWith('link:'))
    // Служебной учётной записи не уходит ничего и ни в один канал (ADR-0130):
    // читать уведомления некому, а письма и Telegram утекали бы в чужой ящик
    const service = await serviceAccountIds(addressed)
    // Не уведомляем автора о его же действии
    const recipients = addressed.filter((id) => !service.has(id) && id !== input.actorId)
    if (recipients.length === 0) return

    const aggregateKey =
      input.aggregateKey ?? `${input.category}:${input.objectId ?? 'none'}:${input.titleKey}`
    const dedupeKey = input.dedupeKey ?? deliveryDedupeKey(input, aggregateKey)
    const eventId = currentEventDelivery()?.eventId ?? null
    // Получатели обрабатываются пачкой (ADR-0222): настройки, повторы, агрегация и вставка —
    // запрос на пачку, а не на получателя; доставка — одна на всех после записи.
    // Внешние каналы (Telegram) — только у тех, кому они доступны: привязан аккаунт
    const external = await availableChannels(recipients)
    // Тишина получателя глушит внешние каналы у всего, кроме срочного (ADR-0140)
    const quiet = input.urgent ? new Set<string>() : await quietRecipients(recipients)
    const preferences = await preferencesOf(recipients, input.category)

    const planned = new Map<string, DeliveryPlan>()
    for (const userId of recipients) {
      const modes = resolveChannels(
        input.category,
        preferences.get(userId) ?? [],
        input.channels,
        external.get(userId),
        Boolean(input.urgent || input.direct),
      )
      if (quiet.has(userId)) muteExternal(modes)
      const channels = Object.keys(modes) as NotificationChannel[]
      if (channels.length === 0) continue
      // Внешние каналы доставляют сразу: дайджеста у них нет, слитые повторы не
      // отправляются (как и письма) — иначе мессенджер получал бы каждое изменение
      const immediate = EXTERNAL_CHANNELS.filter((channel) => modes[channel] !== undefined)
      planned.set(userId, { modes, channels, immediate })
    }
    if (planned.size === 0) return
    const deliveries: Delivery[] = []

    // Повторная доставка события (ADR-0171): уведомление уже создано — второго нет,
    // досылается только то, что не успело уйти в первый раз (сбой посреди обработки)
    if (dedupeKey) {
      const repeats = await db()
        .select({
          id: notifications.id,
          userId: notifications.userId,
          externalSentAt: notifications.externalSentAt,
        })
        .from(notifications)
        .where(
          and(
            inArray(notifications.userId, [...planned.keys()]),
            eq(notifications.dedupeKey, dedupeKey),
          ),
        )
      for (const repeat of repeats) {
        const plan = planned.get(repeat.userId)
        if (!plan) continue
        planned.delete(repeat.userId)
        deliveries.push({
          userId: repeat.userId,
          id: repeat.id,
          modes: plan.modes,
          external: repeat.externalSentAt ? [] : plan.immediate,
        })
      }
    }

    // Срочное (алерт, опасное явление, эскалация) — каждое отдельной строкой: сводка
    // «3 изменения в …» спрятала бы суть тревоги (ADR-0168)
    if (!input.urgent && planned.size > 0) {
      const existing = await db()
        .select({ id: notifications.id, userId: notifications.userId })
        .from(notifications)
        .where(
          and(
            inArray(notifications.userId, [...planned.keys()]),
            eq(notifications.aggregateKey, aggregateKey),
            isNull(notifications.readAt),
            sql`${notifications.createdAt} > now() - make_interval(mins => ${AGGREGATE_WINDOW_MINUTES})`,
          ),
        )
      const aggregated = new Map<string, number>()
      for (const row of existing) {
        if (!aggregated.has(row.userId)) aggregated.set(row.userId, row.id)
      }
      if (aggregated.size > 0) {
        await db()
          .update(notifications)
          .set({ aggregateCount: sql`${notifications.aggregateCount} + 1`, createdAt: sql`now()` })
          .where(inArray(notifications.id, [...aggregated.values()]))
        for (const [userId, id] of aggregated) {
          planned.delete(userId)
          emitToUser(userId, 'notification.new', { aggregated: true, id: String(id) })
        }
      }
    }

    if (planned.size > 0) {
      const created = await db()
        .insert(notifications)
        .values(
          [...planned].map(([userId, plan]) => ({
            userId,
            eventId,
            category: input.category,
            titleKey: input.titleKey,
            params: (input.params ?? {}) as Record<string, unknown>,
            objectId: input.objectId ?? null,
            actorId: input.actorId ?? null,
            url: input.url ?? null,
            channels: plan.channels,
            aggregateKey,
            dedupeKey,
          })),
        )
        // Та же доставка в параллельном потребителе успела раньше — второе не нужно
        .onConflictDoNothing()
        .returning({ id: notifications.id, userId: notifications.userId })
      for (const row of created) {
        const plan = planned.get(row.userId)
        if (!plan) continue
        emitToUser(row.userId, 'notification.new', { id: String(row.id), aggregated: false })
        deliveries.push({
          userId: row.userId,
          id: row.id,
          modes: plan.modes,
          external: plan.immediate,
        })
      }
    }

    await completeDelivery(deliveries)
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
        (['app', 'email', 'telegram', 'push'] as const).map((channel) => ({
          category,
          channel,
          mode: categoryDefaultModes(category)?.[channel] ?? 'off',
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
 * Правила по умолчанию (12-calendar-notifications-home.md §2) категорий ядра: действия и
 * упоминания — во все каналы, включая Telegram; остальное в Telegram — по выбору. Push —
 * как Telegram (ADR-0153): сотрудник, подписавший устройство, ждёт от него тех же действий.
 * Категории модулей объявляют модули (`registerNotificationCategory`, ADR-0182).
 */
type ChannelModes = Partial<Record<NotificationChannel, DeliveryMode>>
const KERNEL_DEFAULT_MODES: Record<string, ChannelModes> = {
  inbox: { app: 'immediate', email: 'immediate', telegram: 'immediate', push: 'immediate' },
  mention: { app: 'immediate', email: 'immediate', telegram: 'immediate', push: 'immediate' },
  discussion: { app: 'immediate', email: 'digest' },
  object: { app: 'immediate', email: 'off' },
  system: { app: 'immediate', email: 'digest' },
}
const moduleDefaultModes = new Map<string, ChannelModes>()

/**
 * Категория уведомлений модуля и её режимы по умолчанию (ADR-0182): ядро не знает
 * категорий модулей по именам. Регистрируется при старте в любой роли процесса.
 */
export function registerNotificationCategory(
  category: NotificationCategory,
  defaults: ChannelModes,
): void {
  const taken = KERNEL_DEFAULT_MODES[category] ?? moduleDefaultModes.get(category)
  if (taken && JSON.stringify(taken) !== JSON.stringify(defaults)) {
    throw new Error(`Категория уведомлений «${category}» уже объявлена`)
  }
  moduleDefaultModes.set(category, defaults)
}

/** Режимы категории по умолчанию: ядра или модуля; не объявленная — только в приложении. */
export function categoryDefaultModes(category: string): ChannelModes | undefined {
  return KERNEL_DEFAULT_MODES[category] ?? moduleDefaultModes.get(category)
}

type DeliveryModes = Partial<Record<NotificationChannel, DeliveryMode>>

/** Что получателю положено по каналам — до записи уведомления. */
interface DeliveryPlan {
  modes: DeliveryModes
  channels: NotificationChannel[]
  immediate: ExternalChannel[]
}

/** Записанное уведомление получателя и каналы, куда его осталось доставить. */
interface Delivery {
  userId: string
  id: number
  modes: DeliveryModes
  external: ExternalChannel[]
}

/**
 * Доставка записанных уведомлений пачкой (ADR-0222): письма «немедленно» — одним вызовом
 * (уже отправленные `deliverEmail` пропускает), внешние каналы — одной пачкой сообщений
 * на канал с отметкой: повтор события их второй раз не шлёт. Вызывается после записи
 * всех строк — внешний канал не опережает базу. Ошибка канала не ломает уведомление:
 * письмо останется в очереди дайджеста.
 */
async function completeDelivery(deliveries: Delivery[]): Promise<void> {
  // E-mail: «немедленно» уходит сразу, «дайджест» — заданием по расписанию
  const emailIds = deliveries
    .filter((delivery) => delivery.modes.email === 'immediate')
    .map((delivery) => delivery.id)
  if (emailIds.length > 0) {
    try {
      await deliverEmail(emailIds)
    } catch (error) {
      logger().error({ err: error }, 'не удалось отправить уведомление почтой')
    }
  }
  const pending = deliveries.filter((delivery) => delivery.external.length > 0)
  if (pending.length === 0) return
  try {
    await deliverExternal(pending)
    await db()
      .update(notifications)
      .set({ externalSentAt: sql`now()` })
      .where(
        inArray(
          notifications.id,
          pending.map((delivery) => delivery.id),
        ),
      )
  } catch (error) {
    logger().error({ err: error }, 'не удалось доставить уведомление во внешний канал')
  }
}

/**
 * Ключ повтора уведомления в обработке события (ADR-0171): подписчик, событие и
 * содержание. Разные уведомления одного события (два правила, два текста) — разные
 * ключи; повторная доставка того же события даёт тот же ключ.
 */
function deliveryDedupeKey(input: NotifyInput, aggregateKey: string): string | null {
  const delivery = currentEventDelivery()
  if (!delivery) return null
  const content = createHash('sha256')
    .update(
      stableJson([
        input.category,
        input.titleKey,
        input.objectId ?? null,
        input.url ?? null,
        aggregateKey,
        input.params ?? {},
      ]),
    )
    .digest('hex')
    .slice(0, 24)
  return `${delivery.subscriber}:${delivery.eventId}:${content}`
}

/** JSON с упорядоченными ключами: одинаковое содержание — одинаковая строка. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Получатель «в тишине» (ADR-0140): Telegram и push молчат, письмо «немедленно» уйдёт
 * с дайджестом, когда тишина кончится, значок в приложении остаётся. Если заглушено всё,
 * что просили, уведомление ждёт в приложении — сообщение не теряется.
 */
function muteExternal(modes: Partial<Record<NotificationChannel, DeliveryMode>>): void {
  const requested = Object.keys(modes).length
  for (const channel of EXTERNAL_CHANNELS) delete modes[channel]
  if (modes.email === 'immediate') modes.email = 'digest'
  if (requested > 0 && Object.keys(modes).length === 0) modes.app = 'immediate'
}

const isExternal = (channel: NotificationChannel): channel is ExternalChannel =>
  (EXTERNAL_CHANNELS as readonly string[]).includes(channel)

/** Настройки получателей по категории — одним запросом на пачку. */
async function preferencesOf(
  userIds: string[],
  category: NotificationCategory,
): Promise<Map<string, Array<{ channel: string; mode: string }>>> {
  const rows = await db()
    .select({
      userId: notificationPreferences.userId,
      channel: notificationPreferences.channel,
      mode: notificationPreferences.mode,
    })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.userId, userIds),
        eq(notificationPreferences.category, category),
      ),
    )
  const result = new Map<string, Array<{ channel: string; mode: string }>>()
  for (const row of rows) {
    result.set(row.userId, [...(result.get(row.userId) ?? []), row])
  }
  return result
}

function resolveChannels(
  category: NotificationCategory,
  prefs: Array<{ channel: string; mode: string }>,
  requested: NotificationChannel[] | undefined,
  available: Set<ExternalChannel> | undefined,
  direct = false,
): DeliveryModes {
  const defaults = categoryDefaultModes(category) ?? { app: 'immediate' }
  const result: DeliveryModes = {}
  const candidates = requested ?? (['app', 'email', 'telegram', 'push'] as NotificationChannel[])

  for (const channel of candidates) {
    if (isExternal(channel) && !available?.has(channel)) continue
    const override = prefs.find((p) => p.channel === channel)?.mode as DeliveryMode | undefined
    if (direct && requested) {
      // Канал выбран явно (напоминание, правило): доставка сразу, если канал не выключен
      if (override !== 'off') result[channel] = 'immediate'
      continue
    }
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
 * Доставка новых уведомлений во внешние каналы получателей (Telegram): текст — на языке
 * получателя, ссылка открывает вкладку объекта. Строки, сводки объектов и кнопки дел
 * читаются запросом на пачку, в канал уходит одна пачка сообщений (ADR-0222).
 */
async function deliverExternal(
  items: ReadonlyArray<{ id: number; external: ExternalChannel[] }>,
): Promise<void> {
  const rows = await db()
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
    .where(
      inArray(
        notifications.id,
        items.map((item) => item.id),
      ),
    )
  if (rows.length === 0) return
  const rendered = await renderForDelivery(rows)
  // Кнопки дел получателя по объекту: «Принять», «Отчитаться», «Продлить» (ADR-0082)
  const byObject = new Map<string, typeof rows>()
  for (const row of rows) {
    if (row.objectId) byObject.set(row.objectId, [...(byObject.get(row.objectId) ?? []), row])
  }
  const actions = new Map<number, InboxOpenAction[]>()
  for (const [objectId, group] of byObject) {
    const open = await InboxService.openActionsFor(
      objectId,
      group.map((row) => row.userId),
    )
    for (const row of group) actions.set(row.id, open.get(row.userId) ?? [])
  }

  const wanted = new Map(items.map((item) => [item.id, item.external]))
  for (const channel of EXTERNAL_CHANNELS) {
    const messages: ChannelMessage[] = []
    for (const row of rows) {
      const text = rendered.get(row.id)
      if (!text || !wanted.get(row.id)?.includes(channel)) continue
      messages.push({
        notificationId: row.id,
        userId: row.userId,
        locale: (row.locale as Locale | null) ?? 'ru',
        category: row.category as NotificationCategory,
        text: text.text,
        url: text.href,
        actions: (actions.get(row.id) ?? []).map((action) => ({
          itemId: action.itemId,
          key: action.key,
          labelKey: action.labelKey,
          requiresComment: action.requiresComment,
          input: action.input,
        })),
      })
    }
    if (messages.length > 0) await notificationChannel(channel)?.deliver(messages)
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

    // Сбой письма одному получателю не останавливает письма остальным (ADR-0222)
    const delivered = await sendMail({
      to: first.email,
      subject,
      html: `<p>${escapeHtml(first.displayName)},</p><ul>${lines.join('')}</ul><p><a href="${escapeHtml(base)}">${escapeHtml(base)}</a></p>`,
    }).catch((error: unknown) => {
      logger().error(
        { err: error, userId: first.userId },
        'не удалось отправить уведомление почтой',
      )
      return false
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
    .select({ id: notifications.id, userId: notifications.userId })
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

  // Получателям «в тишине» дайджест подождёт до её конца (ADR-0140)
  const quiet = await quietRecipients([...new Set(pending.map((row) => row.userId))])
  return deliverEmail(pending.filter((row) => !quiet.has(row.userId)).map((row) => row.id))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
