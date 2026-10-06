import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, Uuid } from '../common/primitives.js'
import { IncomingCall } from '../meetings/meeting.js'
import { InboxCounts } from '../notifications/inbox.js'
import { ROOMS_PER_SUBSCRIBE } from './limits.js'

/**
 * Протокол realtime (16-api-and-events.md §3, ADR-0192): все сообщения шлюза в обе
 * стороны — имя и нагрузка.
 *  - Сервер шлёт только события `RT_SERVER_PAYLOADS`: `emitToRoom`, `emitToUser`,
 *    ретрансляция из worker (ADR-0169), прогресс заданий из `rt:job`. Клиент слушает их же.
 *  - Клиент шлёт только `RT_CLIENT_PAYLOADS`; шлюз разбирает их этими схемами — браузеру
 *    сервер не доверяет.
 *  - Тест `__tests__/handlers.test.ts` обходит отправки и подписки api и web: событие вне
 *    карты, событие, которое шлют, но не слушают, и наоборот, роняют его.
 *
 * Комнаты: `user:{id}`, `space:{id}`, `object:{id}`, `conversation:{id}`, `job:{id}`.
 */
export const RoomName = z
  .string()
  .regex(/^(user|space|object|conversation|job):[0-9a-fA-F-]{8,36}$/, 'некорректное имя комнаты')

// ─── Клиент → сервер ─────────────────────────────────────────────────────────

/** Подписка на комнаты и отписка; вход в каждую комнату шлюз проверяет правами. */
export const SubscribeInput = z.object({
  rooms: z.array(RoomName).min(1).max(ROOMS_PER_SUBSCRIBE),
})
export type SubscribeInput = z.infer<typeof SubscribeInput>

/** Ответ на подписку: в какие комнаты впустили, в какие нет. */
export const SubscribeAck = z.object({
  granted: z.array(RoomName),
  denied: z.array(RoomName),
})
export type SubscribeAck = z.infer<typeof SubscribeAck>

/** Вкладка объекта видна (`presence.view`, раз в 30 с) или ушла из вида (`presence.leave`). */
export const RtPresenceTarget = z.object({ objectId: Uuid })

/** «Печатает» в беседе: шлюз пересылает соседям по комнате, в базу не пишет (ADR-0161). */
export const RtTypingSignal = z.object({ conversationId: Uuid })

export const RT_CLIENT_PAYLOADS = {
  subscribe: SubscribeInput,
  unsubscribe: SubscribeInput,
  'presence.view': RtPresenceTarget,
  'presence.leave': RtPresenceTarget,
  typing: RtTypingSignal,
} as const satisfies Record<string, z.ZodType>

export type RtClientEvent = keyof typeof RT_CLIENT_PAYLOADS
export const RT_CLIENT_EVENTS = Object.keys(RT_CLIENT_PAYLOADS) as RtClientEvent[]
export type RtClientPayload<E extends RtClientEvent> = z.infer<(typeof RT_CLIENT_PAYLOADS)[E]>

/** Карта событий клиента для Socket.IO: имя → отправка. Подписка отвечает подтверждением. */
export type RtClientEvents = {
  [E in RtClientEvent]: E extends 'subscribe'
    ? (payload: RtClientPayload<E>, ack?: (result: SubscribeAck) => void) => void
    : (payload: RtClientPayload<E>) => void
}

// ─── Сервер → клиент ─────────────────────────────────────────────────────────

/**
 * Объект изменился (комната `object:{id}`): открытые вкладки перечитывают все его запросы.
 * `changedFields` — что именно (`['tags']`, `['transcript']`…), `null` — неизвестно.
 */
export const RtObjectUpdated = z.object({
  id: Uuid,
  type: z.string(),
  /** Версия не передаётся (`0`): клиент перечитывает объект, а не сравнивает версии. */
  version: z.number().int(),
  changedFields: z.array(z.string()).nullable(),
  actorId: Uuid.nullable(),
})

/** Объект удалён или убран в корзину. */
export const RtObjectRemoved = z.object({ id: Uuid })

/**
 * Сообщение обсуждения — в комнаты беседы и объекта: новое (`message.posted`), правка,
 * удаление или реакция (`message.updated`).
 */
export const RtMessageChanged = z.object({
  conversationId: Uuid,
  messageId: z.string(),
  objectId: Uuid,
})

/** Участник дочитал беседу до сообщения — в комнату беседы (ADR-0161). */
export const RtMessageRead = z.object({
  conversationId: Uuid,
  messageId: z.string(),
  userId: Uuid,
})

/** В ленте активности объекта появилась запись. */
export const RtActivityAdded = z.object({ objectId: Uuid })

/** Новое уведомление; `aggregated` — прибавилось к непрочитанному того же рода. */
export const RtNotificationNew = z.object({ id: BigIntString, aggregated: z.boolean() })

/** Счётчики «Входящих» пересчитаны. */
export const RtInboxChanged = z.object({ counts: InboxCounts })

/** Ход задания — в комнаты задания и его инициатора. */
export const RtJobProgress = z.object({
  jobId: Uuid,
  progress: z.number().min(0).max(1),
  message: z.string().nullable(),
})

/** Попытка задания закончилась; `retrying` — сбой, задание вернулось в очередь. */
export const RtJobFinished = z.object({
  jobId: Uuid,
  status: z.enum(['succeeded', 'failed', 'cancelled', 'retrying']),
})

/** Кто смотрит объект — в комнату `object:{id}`, когда смотрящий пришёл или ушёл. */
export const RtPresence = z.object({
  objectId: Uuid,
  users: z.array(z.object({ id: Uuid, displayName: z.string(), avatarUrl: z.string().nullable() })),
})

/** Собеседник печатает — соседям по комнате беседы. */
export const RtTyping = z.object({ conversationId: Uuid, userId: Uuid, displayName: z.string() })

/** Права на объект отозваны: клиент закрывает его вкладку. */
export const RtAclRevoked = z.object({ objectId: Uuid })

/** Календарь пользователя изменился (ADR-0081); `eventId` — какое событие, если известно. */
export const RtCalendarChanged = z.object({ eventId: Uuid.optional() })

/** Беседа изменилась: сообщение, состав, название, настройки (ADR-0090). */
export const RtChatChanged = z.object({ conversationId: Uuid })

/** Свой статус «на встрече» сменился — в комнату пользователя (ADR-0090). */
export const RtPresenceChanged = z.object({ userId: Uuid, inMeeting: z.boolean() })

/** Что случилось с комнатой встречи (ADR-0091). */
export const MEETING_CHANGES = [
  'started',
  'ended',
  'participant_joined',
  'participant_left',
  'secretary_changed',
] as const
export type MeetingChange = (typeof MEETING_CHANGES)[number]

/** Состав или состояние комнаты встречи — в комнату её объекта. */
export const RtMeetingChanged = z.object({ meetingId: Uuid, change: z.enum(MEETING_CHANGES) })

/** Гость по ссылке просится в комнату — ведущему, в комнату объекта встречи (ADR-0091). */
export const RtMeetingKnock = z.object({ meetingId: Uuid, requestId: Uuid })

/**
 * Гость ждёт в комнате ожидания — ведущему в `user:{id}`, где бы он ни был (ADR-0193): имя
 * гостя и название встречи, чтобы показать, кто и куда просится, без запроса за заявками.
 */
export const RtMeetingGuestWaiting = z.object({
  meetingId: Uuid,
  requestId: Uuid,
  name: z.string(),
  title: z.string(),
})

/** Приглашённый отклонил звонок — звонящему в `user:{id}` (ADR-0193). */
export const RtCallDeclined = z.object({ meetingId: Uuid, user: UserRef.nullable() })

export const RT_SERVER_PAYLOADS = {
  'object.updated': RtObjectUpdated,
  'object.removed': RtObjectRemoved,
  'message.posted': RtMessageChanged,
  'message.updated': RtMessageChanged,
  'message.read': RtMessageRead,
  'activity.added': RtActivityAdded,
  'notification.new': RtNotificationNew,
  'inbox.changed': RtInboxChanged,
  'job.progress': RtJobProgress,
  'job.finished': RtJobFinished,
  presence: RtPresence,
  typing: RtTyping,
  'acl.revoked': RtAclRevoked,
  'calendar.changed': RtCalendarChanged,
  'chat.changed': RtChatChanged,
  'presence.changed': RtPresenceChanged,
  'meeting.changed': RtMeetingChanged,
  'meeting.knock': RtMeetingKnock,
  'meeting.guest_waiting': RtMeetingGuestWaiting,
  /** Входящий звонок — приглашённому, в комнату `user:{id}` (ADR-0091). */
  'call.incoming': IncomingCall,
  'call.declined': RtCallDeclined,
} as const satisfies Record<string, z.ZodType>

export type RtServerEvent = keyof typeof RT_SERVER_PAYLOADS
export const RT_SERVER_EVENTS = Object.keys(RT_SERVER_PAYLOADS) as RtServerEvent[]
export type RtServerPayload<E extends RtServerEvent> = z.infer<(typeof RT_SERVER_PAYLOADS)[E]>

/** Карта событий сервера для Socket.IO: имя → обработчик нагрузки. */
export type RtServerEvents = { [E in RtServerEvent]: (payload: RtServerPayload<E>) => void }
