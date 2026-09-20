import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { RecordingStatus } from './recording.js'

/**
 * Встречи и звонки (11-communications-meetings.md §3, ADR-0089): объект реестра
 * `meeting` — комната медиасервера с участниками, чатом и (позже) записью.
 * Звонок (`call`) поднимается из беседы на лету, встреча (`scheduled`) живёт
 * рядом с событием календаря: событие ссылается на встречу (`events.meeting_id`),
 * список участников синхронизирует календарь.
 */

export const MEETING_KINDS = ['call', 'scheduled'] as const
export const MeetingKind = z.enum(MEETING_KINDS)
export type MeetingKind = z.infer<typeof MeetingKind>

/**
 * `planned` — комната готова, но никто не вошёл; `live` — идёт; `ended` —
 * завершена (войти нельзя, остаются запись, расшифровка и протокол);
 * `cancelled` — событие отменено до начала.
 */
export const MEETING_STATUSES = ['planned', 'live', 'ended', 'cancelled'] as const
export const MeetingStatus = z.enum(MEETING_STATUSES)
export type MeetingStatus = z.infer<typeof MeetingStatus>

/** Организатор ведёт встречу, участник входит, гость — по ссылке, без объектов. */
export const MEETING_ROLES = ['organizer', 'participant', 'guest'] as const
export const MeetingRole = z.enum(MEETING_ROLES)
export type MeetingRole = z.infer<typeof MeetingRole>

export const MeetingParticipant = z.object({
  user: UserRef,
  role: MeetingRole,
  /** Сейчас в комнате. */
  inRoom: z.boolean(),
  joinedAt: Timestamp.nullable(),
  leftAt: Timestamp.nullable(),
})
export type MeetingParticipant = z.infer<typeof MeetingParticipant>

/** Что смотрящий может сделать со встречей. */
export const MeetingPermissions = z.object({
  join: z.boolean(),
  manage: z.boolean(),
  end: z.boolean(),
  record: z.boolean(),
})
export type MeetingPermissions = z.infer<typeof MeetingPermissions>

/**
 * Индикатор записи: идущая запись видна всем участникам комнаты, а не только
 * тому, кто её включил (11-communications-meetings.md §3, ADR-0092).
 */
export const MeetingRecordingState = z.object({
  id: Uuid,
  status: RecordingStatus,
  startedAt: Timestamp.nullable(),
})
export type MeetingRecordingState = z.infer<typeof MeetingRecordingState>

export const MeetingRecord = z.object({
  id: Uuid,
  kind: MeetingKind,
  status: MeetingStatus,
  title: z.string(),
  /** Комната медиасервера — идентификатор для клиента. */
  roomName: z.string(),
  /** Событие календаря, если встреча по расписанию. */
  eventId: Uuid.nullable(),
  /** Беседа, из которой подняли звонок (чат встречи — обсуждение её объекта). */
  conversationId: Uuid.nullable(),
  organizer: UserRef.nullable(),
  participants: z.array(MeetingParticipant),
  /** Сколько человек в комнате сейчас. */
  inRoom: z.number().int(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  can: MeetingPermissions,
  /** Идущая запись встречи или `null` — индикатор в интерфейсе комнаты. */
  recording: MeetingRecordingState.nullable(),
  createdAt: Timestamp,
})
export type MeetingRecord = z.infer<typeof MeetingRecord>

/**
 * Звонок из беседы: участники — собеседники; встреча по расписанию заводится
 * календарём (`MeetingsPublic.ensureForEvent`), а не этим входом.
 */
export const MeetingCreateInput = z.object({
  title: z.string().trim().min(1).max(300),
  conversationId: Uuid.optional(),
  participantIds: z.array(Uuid).max(100).default([]),
})
export type MeetingCreateInput = z.infer<typeof MeetingCreateInput>

/** Данные для подключения клиента к комнате: адрес, токен и его срок. */
export const MeetingJoin = z.object({
  meetingId: Uuid,
  roomName: z.string(),
  /** Адрес медиасервера для клиента (`wss://…`). */
  url: z.string(),
  token: z.string(),
  /** Кем клиент войдёт в комнату. */
  identity: z.string(),
  displayName: z.string(),
  expiresAt: Timestamp,
  canPublish: z.boolean(),
  canRecord: z.boolean(),
})
export type MeetingJoin = z.infer<typeof MeetingJoin>

export const MeetingListQuery = z.object({
  /** `live` — идущие, `mine` — мои (по умолчанию), `all` — все доступные. */
  scope: z.enum(['mine', 'live', 'all']).default('mine'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MeetingListQuery = z.infer<typeof MeetingListQuery>

export const MeetingList = z.object({ items: z.array(MeetingRecord) })
export type MeetingList = z.infer<typeof MeetingList>

/** Состояние медиасервера для интерфейса: выключен — кнопок звонка нет. */
export const MeetingsStatus = z.object({
  enabled: z.boolean(),
  url: z.string().nullable(),
})
export type MeetingsStatus = z.infer<typeof MeetingsStatus>

/**
 * Комната ожидания и гости по ссылке (ADR-0091). Ссылка — подписанный токен с
 * ограниченным сроком: пользователем системы гость не становится и доступа к
 * объектам не получает; всё, что ему видно, — название встречи и комната.
 */
export const MeetingGuestLinkInput = z.object({
  /** Срок ссылки в минутах: от четверти часа до суток. */
  ttlMinutes: z.number().int().min(15).max(1440).default(240),
})
export type MeetingGuestLinkInput = z.infer<typeof MeetingGuestLinkInput>

export const MeetingGuestLink = z.object({
  url: z.string(),
  expiresAt: Timestamp,
})
export type MeetingGuestLink = z.infer<typeof MeetingGuestLink>

/** Что гость узнаёт по ссылке до входа: только название и состояние встречи. */
export const MeetingGuestPreview = z.object({
  title: z.string(),
  status: MeetingStatus,
  /** Медиасервер настроен: иначе входить некуда. */
  enabled: z.boolean(),
})
export type MeetingGuestPreview = z.infer<typeof MeetingGuestPreview>

export const MeetingGuestJoinInput = z.object({
  name: z.string().trim().min(2).max(80),
  /** Заявка, поданная раньше: клиент ждёт решения организатора. */
  requestId: z.string().min(8).max(64).optional(),
})
export type MeetingGuestJoinInput = z.infer<typeof MeetingGuestJoinInput>

/** Ответ гостю: ждёт решения, впущен (токен комнаты) или отклонён. */
export const MeetingGuestJoin = z.object({
  state: z.enum(['waiting', 'admitted', 'denied']),
  requestId: z.string(),
  meeting: MeetingGuestPreview,
  join: MeetingJoin.nullable(),
})
export type MeetingGuestJoin = z.infer<typeof MeetingGuestJoin>

/** Заявка из комнаты ожидания — тому, кто ведёт встречу. */
export const MeetingKnock = z.object({
  id: z.string(),
  name: z.string(),
  requestedAt: Timestamp,
})
export type MeetingKnock = z.infer<typeof MeetingKnock>

export const MeetingKnockList = z.object({ items: z.array(MeetingKnock) })
export type MeetingKnockList = z.infer<typeof MeetingKnockList>

export const MeetingKnockDecision = z.object({ admit: z.boolean() })
export type MeetingKnockDecision = z.infer<typeof MeetingKnockDecision>

/**
 * Сообщения участников по каналу данных комнаты (ADR-0091): поднятая рука,
 * реакция и «Показать всем» идут между клиентами через медиасервер, api их не
 * видит. Получатель открывает объект своими правами — сигнал доступа не даёт.
 */
export const MeetingSignal = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hand'), raised: z.boolean() }),
  z.object({ type: z.literal('reaction'), emoji: z.string().min(1).max(8) }),
  z.object({
    type: z.literal('show'),
    objectId: Uuid,
    objectType: z.string().min(1).max(40),
    title: z.string().min(1).max(300),
  }),
])
export type MeetingSignal = z.infer<typeof MeetingSignal>

/** Входящий звонок — компактное сообщение realtime приглашённому (ADR-0091). */
export const IncomingCall = z.object({
  meetingId: Uuid,
  title: z.string(),
  caller: UserRef.nullable(),
  conversationId: Uuid.nullable(),
})
export type IncomingCall = z.infer<typeof IncomingCall>
