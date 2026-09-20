import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

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
  limit: z.number().int().min(1).max(100).default(50),
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
