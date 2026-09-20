import type {
  MeetingCreateInput,
  MeetingJoin,
  MeetingListQuery,
  MeetingParticipant,
  MeetingRecord,
  MeetingRole,
  UserRef,
} from '@kchs/contracts'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { grantAccess, revokeAccess } from '~/kernel/access/acl-service.js'
import { authorize, hasCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { meetingParticipants, meetings, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import {
  closeRoom,
  GUEST_TOKEN_TTL_SECONDS,
  mediaConfig,
  roomNameFor,
  roomToken,
} from './livekit.js'
import { meetingsSpaceId } from './space.js'

/** Способность вести запись встречи (11-communications-meetings.md §3). */
export const RECORD_CAPABILITY = 'meetings.record'

export interface MeetingRow {
  id: string
  kind: string
  status: string
  roomName: string
  eventId: string | null
  conversationId: string | null
  organizerId: string | null
  startsAt: string | null
  endsAt: string | null
  startedAt: string | null
  endedAt: string | null
  title: string
  createdAt: string
}

const select = (executor: Executor) =>
  executor
    .select({
      id: meetings.id,
      kind: meetings.kind,
      status: meetings.status,
      roomName: meetings.roomName,
      eventId: meetings.eventId,
      conversationId: meetings.conversationId,
      organizerId: meetings.organizerId,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      title: objects.title,
      createdAt: meetings.createdAt,
    })
    .from(meetings)
    .innerJoin(objects, eq(objects.id, meetings.id))

async function load(executor: Executor, id: string): Promise<MeetingRow | null> {
  const [row] = await select(executor).where(eq(meetings.id, id)).limit(1)
  return (row as MeetingRow | undefined) ?? null
}

function actorOf(ctx: Ctx): string | null {
  return ctx.kind === 'user' ? (ctx.onBehalfOf ?? ctx.userId) : actorId(ctx)
}

/**
 * Участники встречи видят её объект — тихими записями ACL ядра (ADR-0060):
 * так встречу одинаково показывают списки, поиск и `authorize()`.
 */
async function syncAccess(
  tx: Executor,
  ctx: Ctx,
  meetingId: string,
  before: readonly string[],
  after: readonly string[],
  organizerId: string | null,
): Promise<void> {
  const wanted = new Set(after.filter((id) => id !== organizerId))
  const had = new Set(before.filter((id) => id !== organizerId))
  const added = [...wanted].filter((id) => !had.has(id))
  const removed = [...had].filter((id) => !wanted.has(id))
  if (added.length > 0) {
    await grantAccess(
      tx,
      ctx,
      meetingId,
      added.map((id) => ({ principal: { type: 'user' as const, id }, level: 'comment' as const })),
      { quiet: true },
    )
  }
  for (const id of removed) await revokeAccess(tx, ctx, meetingId, { type: 'user', id })
}

async function participantIds(executor: Executor, meetingId: string): Promise<string[]> {
  const rows = await executor
    .select({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))
  return rows.map((row) => row.userId)
}

async function participantsOf(
  executor: Executor,
  meetingId: string,
): Promise<MeetingParticipant[]> {
  const rows = await executor
    .select({
      userId: meetingParticipants.userId,
      role: meetingParticipants.role,
      joinedAt: meetingParticipants.joinedAt,
      leftAt: meetingParticipants.leftAt,
    })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))
  const refs = await directory().refs(rows.map((row) => row.userId))
  const missing = (id: string): UserRef => ({
    id,
    displayName: '—',
    avatarUrl: null,
    position: null,
    unitName: null,
  })
  return rows
    .map((row) => ({
      user: refs.get(row.userId) ?? missing(row.userId),
      role: row.role as MeetingRole,
      inRoom: Boolean(row.joinedAt) && !row.leftAt,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
    }))
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))
}

async function toRecord(
  ctx: UserCtx,
  row: MeetingRow,
  executor: Executor = db(),
): Promise<MeetingRecord> {
  const participants = await participantsOf(executor, row.id)
  const [manage, end] = await Promise.all([
    authorize(ctx, 'manage', row.id, { soft: true }),
    authorize(ctx, 'end', row.id, { soft: true }),
  ])
  const live = row.status === 'planned' || row.status === 'live'
  return {
    id: row.id,
    kind: row.kind as MeetingRecord['kind'],
    status: row.status as MeetingRecord['status'],
    title: row.title,
    roomName: row.roomName,
    eventId: row.eventId,
    conversationId: row.conversationId,
    organizer: row.organizerId
      ? ((await directory().refs([row.organizerId])).get(row.organizerId) ?? null)
      : null,
    participants,
    inRoom: participants.filter((item) => item.inRoom).length,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    can: {
      join: live && mediaConfig() !== null,
      manage: manage.allowed,
      end: end.allowed && live,
      record: end.allowed && hasCapability(ctx, RECORD_CAPABILITY),
    },
    createdAt: row.createdAt,
  }
}

export interface CreateMeetingInput {
  kind: 'call' | 'scheduled'
  title: string
  eventId?: string | null
  conversationId?: string | null
  organizerId?: string | null
  participantIds?: readonly string[]
  startsAt?: string | null
  endsAt?: string | null
}

export const MeetingService = {
  load,

  /**
   * Встреча — объект реестра в системном пространстве встреч: организатор
   * владеет ею, приглашённые получают доступ участием. Комната медиасервера
   * поднимается при первом входе, имя известно сразу (ADR-0089).
   */
  async create(tx: Executor, ctx: Ctx, input: CreateMeetingInput): Promise<string> {
    const spaceId = await meetingsSpaceId(tx)
    const organizerId = input.organizerId === undefined ? actorOf(ctx) : input.organizerId
    const id = newId()
    await ObjectService.create(tx, ctx, {
      id,
      type: 'meeting',
      spaceId,
      title: input.title,
      ...(organizerId ? { ownerId: organizerId } : {}),
      accessMode: 'restricted',
    })
    await tx.insert(meetings).values({
      id,
      kind: input.kind,
      status: 'planned',
      roomName: roomNameFor(id),
      eventId: input.eventId ?? null,
      conversationId: input.conversationId ?? null,
      organizerId,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    })
    const invited = [
      ...new Set([...(organizerId ? [organizerId] : []), ...(input.participantIds ?? [])]),
    ]
    const active = await directory().activeUsers(invited)
    if (active.length > 0) {
      await tx.insert(meetingParticipants).values(
        active.map((userId) => ({
          meetingId: id,
          userId,
          role: userId === organizerId ? 'organizer' : 'participant',
        })),
      )
    }
    await syncAccess(tx, ctx, id, [], active, organizerId)
    await publishEvent(tx, ctx, {
      type: 'meeting.scheduled',
      object: { id, type: 'meeting', spaceId, title: input.title },
      payload: {
        kind: input.kind,
        eventId: input.eventId ?? null,
        conversationId: input.conversationId ?? null,
        participantIds: active,
      },
    })
    return id
  },

  /** Приглашённые встречи: список ведёт тот, кто её завёл (календарь — по событию). */
  async setParticipants(
    tx: Executor,
    ctx: Ctx,
    meetingId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const row = await load(tx, meetingId)
    if (!row) throw errors.notFound('Встреча')
    const before = await participantIds(tx, meetingId)
    const wanted = [
      ...new Set([
        ...(row.organizerId ? [row.organizerId] : []),
        ...(await directory().activeUsers([...userIds])),
      ]),
    ]
    const removed = before.filter((id) => !wanted.includes(id))
    const added = wanted.filter((id) => !before.includes(id))
    if (removed.length > 0) {
      await tx
        .delete(meetingParticipants)
        .where(
          and(
            eq(meetingParticipants.meetingId, meetingId),
            inArray(meetingParticipants.userId, removed),
          ),
        )
    }
    if (added.length > 0) {
      await tx.insert(meetingParticipants).values(
        added.map((userId) => ({
          meetingId,
          userId,
          role: userId === row.organizerId ? 'organizer' : 'participant',
        })),
      )
    }
    if (added.length > 0 || removed.length > 0) {
      await syncAccess(tx, ctx, meetingId, before, wanted, row.organizerId)
    }
  },

  async get(ctx: UserCtx, id: string): Promise<MeetingRecord> {
    await authorize(ctx, 'view', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Встреча')
    return toRecord(ctx, row)
  },

  async list(ctx: UserCtx, query: MeetingListQuery): Promise<MeetingRecord[]> {
    const conditions = [visibleObjectsSql(ctx, 'meeting'), isNull(objects.deletedAt)]
    if (query.scope === 'live') conditions.push(eq(meetings.status, 'live'))
    if (query.scope === 'mine') {
      conditions.push(
        sql`${meetings.id} IN (SELECT ${meetingParticipants.meetingId} FROM ${meetingParticipants}
          WHERE ${meetingParticipants.userId} = ${ctx.userId})`,
      )
    }
    const rows = await select(db())
      .where(and(...conditions))
      .orderBy(
        desc(sql`coalesce(${meetings.startedAt}, ${meetings.startsAt}, ${meetings.createdAt})`),
      )
      .limit(query.limit)
    const records: MeetingRecord[] = []
    for (const row of rows as MeetingRow[]) records.push(await toRecord(ctx, row))
    return records
  },

  /**
   * Вход в комнату: право `join` проверяет ядро, токен выпускается на имя
   * участника. Первый вошедший переводит встречу в «идёт».
   */
  async join(ctx: UserCtx, id: string): Promise<MeetingJoin> {
    await authorize(ctx, 'join', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Встреча')
    if (row.status === 'ended' || row.status === 'cancelled') {
      throw errors.conflict('Встреча завершена', { status: row.status })
    }
    const userId = ctx.onBehalfOf ?? ctx.userId
    const started = await db().transaction(async (tx) => {
      const [existing] = await tx
        .select({ role: meetingParticipants.role })
        .from(meetingParticipants)
        .where(and(eq(meetingParticipants.meetingId, id), eq(meetingParticipants.userId, userId)))
        .limit(1)
      if (existing) {
        await tx
          .update(meetingParticipants)
          .set({ joinedAt: sql`now()`, leftAt: null })
          .where(and(eq(meetingParticipants.meetingId, id), eq(meetingParticipants.userId, userId)))
      } else {
        await tx
          .insert(meetingParticipants)
          .values({ meetingId: id, userId, role: 'participant', joinedAt: sql`now()` })
      }
      const first = row.status === 'planned'
      if (first) {
        await tx
          .update(meetings)
          .set({ status: 'live', startedAt: sql`now()` })
          .where(eq(meetings.id, id))
        await publishEvent(tx, ctx, {
          type: 'meeting.started',
          object: { id, type: 'meeting', spaceId: null, title: row.title },
          payload: { kind: row.kind, roomName: row.roomName },
        })
      }
      await publishEvent(tx, ctx, {
        type: 'meeting.participant_joined',
        object: { id, type: 'meeting', spaceId: null, title: row.title },
        payload: { userId, role: existing?.role ?? 'participant' },
      })
      return first
    })
    void started
    const canRecord = hasCapability(ctx, RECORD_CAPABILITY)
    const issued = await roomToken({
      roomName: row.roomName,
      identity: userId,
      displayName: ctx.displayName,
      canPublish: true,
      canRecord,
      metadata: { meetingId: id },
    })
    const media = mediaConfig()
    return {
      meetingId: id,
      roomName: row.roomName,
      url: media?.url ?? '',
      token: issued.token,
      identity: userId,
      displayName: ctx.displayName,
      expiresAt: issued.expiresAt,
      canPublish: true,
      canRecord,
    }
  },

  /** Выход из комнаты: отметка в участниках; встречу это не завершает. */
  async leave(ctx: UserCtx, id: string): Promise<void> {
    const userId = ctx.onBehalfOf ?? ctx.userId
    await db().transaction(async (tx) => {
      const row = await load(tx, id)
      if (!row) throw errors.notFound('Встреча')
      await tx
        .update(meetingParticipants)
        .set({ leftAt: sql`now()` })
        .where(and(eq(meetingParticipants.meetingId, id), eq(meetingParticipants.userId, userId)))
      await publishEvent(tx, ctx, {
        type: 'meeting.participant_left',
        object: { id, type: 'meeting', spaceId: null, title: row.title },
        payload: { userId },
      })
    })
  },

  /** Завершение: организатор (право `end`) или отмена события календарём. */
  async end(
    tx: Executor,
    ctx: Ctx,
    id: string,
    reason: 'manual' | 'empty' | 'cancelled' = 'manual',
  ): Promise<void> {
    const row = await load(tx, id)
    if (!row) throw errors.notFound('Встреча')
    if (row.status === 'ended' || row.status === 'cancelled') return
    const status = reason === 'cancelled' && row.status === 'planned' ? 'cancelled' : 'ended'
    await tx.update(meetings).set({ status, endedAt: sql`now()` }).where(eq(meetings.id, id))
    // Оставшиеся в комнате выходят вместе со встречей: иначе подписчики
    // присутствия навсегда оставят человека «на встрече» (ADR-0090)
    const stillIn = await tx
      .update(meetingParticipants)
      .set({ leftAt: sql`now()` })
      .where(and(eq(meetingParticipants.meetingId, id), isNull(meetingParticipants.leftAt)))
      .returning({ userId: meetingParticipants.userId })
    for (const { userId } of stillIn) {
      await publishEvent(tx, ctx, {
        type: 'meeting.participant_left',
        object: { id, type: 'meeting', spaceId: null, title: row.title },
        payload: { userId },
      })
    }
    const duration = row.startedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(row.startedAt)) / 1000))
      : null
    await publishEvent(tx, ctx, {
      type: 'meeting.ended',
      object: { id, type: 'meeting', spaceId: null, title: row.title },
      payload: { reason, durationSeconds: duration },
    })
    // Комната закрывается после записи в базе: недоступный медиасервер не
    // оставит встречу «идущей»
    await closeRoom(row.roomName)
  },

  /** Токен гостя по ссылке — без прав на объекты, только комната (ADR-0089). */
  async guestToken(id: string, guest: { name: string }): Promise<MeetingJoin> {
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Встреча')
    if (row.status === 'ended' || row.status === 'cancelled') {
      throw errors.conflict('Встреча завершена', { status: row.status })
    }
    const identity = `guest:${newId()}`
    const issued = await roomToken({
      roomName: row.roomName,
      identity,
      displayName: guest.name,
      canPublish: true,
      canRecord: false,
      ttlSeconds: GUEST_TOKEN_TTL_SECONDS,
      metadata: { meetingId: id, guest: true },
    })
    const media = mediaConfig()
    return {
      meetingId: id,
      roomName: row.roomName,
      url: media?.url ?? '',
      token: issued.token,
      identity,
      displayName: guest.name,
      expiresAt: issued.expiresAt,
      canPublish: true,
      canRecord: false,
    }
  },

  /** Звонок из беседы: участники — собеседники, встреча начинается сразу. */
  async startCall(tx: Executor, ctx: UserCtx, input: MeetingCreateInput): Promise<string> {
    const id = await MeetingService.create(tx, ctx, {
      kind: 'call',
      title: input.title,
      conversationId: input.conversationId ?? null,
      participantIds: input.participantIds,
    })
    const invited = (await participantIds(tx, id)).filter(
      (userId) => userId !== (ctx.onBehalfOf ?? ctx.userId),
    )
    await publishEvent(tx, ctx, {
      type: 'call.incoming',
      object: { id, type: 'meeting', spaceId: null, title: input.title },
      payload: {
        meetingId: id,
        callerId: ctx.onBehalfOf ?? ctx.userId,
        conversationId: input.conversationId ?? null,
        userIds: invited,
      },
    })
    return id
  },
}
