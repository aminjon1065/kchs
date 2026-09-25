import type { RecordingRecord, RecordingStatus, TranscriptStatus, UserRef } from '@kchs/contracts'
import { RECORDING_MIME, TRANSCRIBE_JOB } from '@kchs/contracts'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { WebhookEvent } from 'livekit-server-sdk'
import { authorize, hasCapability } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { buckets } from '~/kernel/storage/s3.js'
import { registerGeneratedFile } from '~/modules/files/public.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { meetings, objects, recordings } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { mediaConfig } from './livekit.js'
import {
  egressInfo,
  fileResultOf,
  startRoomRecording,
  stopRoomRecording,
} from './recording-egress.js'
import { expiryOf, keptByLinks, MeetingSettingsService } from './recording-retention.js'
import { meetingsSpaceId } from './space.js'

/** Способность вести запись встречи (11-communications-meetings.md §3). */
export const RECORD_CAPABILITY = 'meetings.record'

const log = () => logger().child({ module: 'meetings' })

interface RecordingRow {
  id: string
  meetingId: string
  status: string
  egressId: string | null
  storageKey: string
  fileId: string | null
  durationS: number | null
  sizeBytes: number | null
  transcriptStatus: string
  error: string | null
  startedBy: string | null
  startedAt: string | null
  endedAt: string | null
  pinnedAt: string | null
  retentionWarnedAt: string | null
  createdAt: string
  title: string
}

const selectRecordings = (executor: Executor) =>
  executor
    .select({
      id: recordings.id,
      meetingId: recordings.meetingId,
      status: recordings.status,
      egressId: recordings.egressId,
      storageKey: recordings.storageKey,
      fileId: recordings.fileId,
      durationS: recordings.durationS,
      sizeBytes: recordings.sizeBytes,
      transcriptStatus: recordings.transcriptStatus,
      error: recordings.error,
      startedBy: recordings.startedBy,
      startedAt: recordings.startedAt,
      endedAt: recordings.endedAt,
      pinnedAt: recordings.pinnedAt,
      retentionWarnedAt: recordings.retentionWarnedAt,
      createdAt: recordings.createdAt,
      title: objects.title,
    })
    .from(recordings)
    .innerJoin(objects, eq(objects.id, recordings.id))

async function loadRecording(executor: Executor, id: string): Promise<RecordingRow | null> {
  const [row] = await selectRecordings(executor).where(eq(recordings.id, id)).limit(1)
  return (row as RecordingRow | undefined) ?? null
}

interface MeetingBrief {
  id: string
  title: string
  roomName: string
  status: string
  organizerId: string | null
}

async function loadMeeting(executor: Executor, id: string): Promise<MeetingBrief | null> {
  const [row] = await executor
    .select({
      id: meetings.id,
      title: objects.title,
      roomName: meetings.roomName,
      status: meetings.status,
      organizerId: meetings.organizerId,
    })
    .from(meetings)
    .innerJoin(objects, eq(objects.id, meetings.id))
    .where(eq(meetings.id, id))
    .limit(1)
  return (row as MeetingBrief | undefined) ?? null
}

/** Ключ записи в бакете файлов: медиасервер пишет туда сам (ADR-0092). */
function recordingKey(meetingId: string, recordingId: string): string {
  return `meetings/${meetingId}/${recordingId}.mp4`
}

function recordingFileName(title: string): string {
  return `${title}.mp4`
}

/** Срок хранения записей: срок установки и записи, попавшие в протокол или дело (N29). */
async function retentionOf(rows: RecordingRow[]) {
  const [{ recordingRetentionMonths: months }, kept] = await Promise.all([
    MeetingSettingsService.current(),
    keptByLinks(rows.map((row) => row.id)),
  ])
  return (row: RecordingRow) => expiryOf(row, months, kept.has(row.id))?.toISOString() ?? null
}

async function toRecord(
  row: RecordingRow,
  options: { canStop: boolean; canPin?: boolean; expiresAt?: string | null },
): Promise<RecordingRecord> {
  const refs = row.startedBy ? await directory().refs([row.startedBy]) : null
  const live = row.status === 'starting' || row.status === 'active'
  return {
    id: row.id,
    meetingId: row.meetingId,
    title: row.title,
    status: row.status as RecordingStatus,
    startedBy: ((row.startedBy ? refs?.get(row.startedBy) : null) ?? null) as UserRef | null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationS,
    sizeBytes: row.sizeBytes,
    fileId: row.fileId,
    fileName: row.fileId ? recordingFileName(row.title) : null,
    transcriptStatus: row.transcriptStatus as TranscriptStatus,
    error: row.error,
    pinnedAt: row.pinnedAt,
    expiresAt: options.expiresAt ?? null,
    can: { stop: live && options.canStop, pin: !live && (options.canPin ?? false) },
    createdAt: row.createdAt,
  }
}

/**
 * Остановка записи: медиасерверу — стоп, в реестре — «докладывается». Файл
 * придёт вебхуком, поэтому статус `ready` ставится не здесь.
 */
async function finishEgress(
  tx: Executor,
  ctx: Ctx,
  row: RecordingRow,
  reason: 'manual' | 'meeting_ended',
): Promise<void> {
  if (row.egressId) await stopRoomRecording(row.egressId)
  await tx
    .update(recordings)
    .set({ status: 'processing', endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(recordings.id, row.id))
  await publishEvent(tx, ctx, {
    type: 'recording.stopped',
    object: { id: row.id, type: 'recording', spaceId: null, title: row.title },
    payload: { meetingId: row.meetingId, reason },
  })
}

/** Сколько ждать вебхука, прежде чем спросить медиасервер самим, с. */
const WEBHOOK_GRACE_SECONDS = 60

/**
 * Запись «докладывается» дольше разумного — вебхук не дошёл (сеть, адрес).
 * Тогда состояние задания спрашивается у медиасервера напрямую: «докладывается»
 * не должно остаться навсегда.
 */
async function reconcile(row: RecordingRow): Promise<RecordingRow | null> {
  if (row.status !== 'processing' || !row.egressId || !mediaConfig()) return null
  const since = row.endedAt ? Date.now() - Date.parse(row.endedAt) : 0
  if (since < WEBHOOK_GRACE_SECONDS * 1000) return null
  const info = await egressInfo(row.egressId)
  if (!info) return null
  if (info.status === 3) await RecordingService.markReady(row.id, fileResultOf(info))
  else if (info.status === 4 || info.status === 5) {
    await RecordingService.markFailed(row.id, info.error || 'медиасервер не сохранил запись')
  } else return null
  return loadRecording(db(), row.id)
}

/** Право включать и выключать запись: способность плюс право вести встречу. */
async function assertCanRecord(ctx: UserCtx, meetingId: string): Promise<void> {
  await authorize(ctx, 'end', meetingId)
  if (!hasCapability(ctx, RECORD_CAPABILITY)) {
    throw errors.forbidden('Нет права записывать встречи')
  }
}

export const RecordingService = {
  /**
   * Включить запись комнаты. Объект записи и её место в хранилище заводятся до
   * обращения к медиасерверу: так сбой Egress виден в реестре, а не теряется.
   */
  async start(ctx: UserCtx, meetingId: string): Promise<RecordingRecord> {
    await assertCanRecord(ctx, meetingId)
    if (!mediaConfig()) throw errors.unavailable('Медиасервер не настроен')
    const meeting = await loadMeeting(db(), meetingId)
    if (!meeting) throw errors.notFound('Встреча')
    if (meeting.status !== 'live' && meeting.status !== 'planned') {
      throw errors.conflict('Встреча завершена', { status: meeting.status })
    }
    const [live] = await db()
      .select({ id: recordings.id })
      .from(recordings)
      .where(
        and(
          eq(recordings.meetingId, meetingId),
          inArray(recordings.status, ['starting', 'active']),
        ),
      )
      .limit(1)
    if (live) throw errors.conflict('Запись уже идёт', { recordingId: live.id })

    const id = newId()
    const storageKey = recordingKey(meetingId, id)
    await db().transaction(async (tx) => {
      const spaceId = await meetingsSpaceId(tx)
      await ObjectService.create(tx, ctx, {
        id,
        type: 'recording',
        spaceId,
        // Ребёнок встречи: запись видит тот, кто видит встречу
        parentId: meetingId,
        title: meeting.title,
        icon: 'recording',
        ...(meeting.organizerId ? { ownerId: meeting.organizerId } : {}),
      })
      await tx.insert(recordings).values({
        id,
        meetingId,
        status: 'starting',
        storageKey,
        startedBy: ctx.onBehalfOf ?? ctx.userId,
        startedAt: sql`now()`,
      })
      await publishEvent(tx, ctx, {
        type: 'recording.started',
        object: { id, type: 'recording', spaceId, title: meeting.title },
        payload: { meetingId, startedBy: ctx.onBehalfOf ?? ctx.userId },
      })
    })

    try {
      const started = await startRoomRecording(meeting.roomName, storageKey)
      await db()
        .update(recordings)
        .set({ status: 'active', egressId: started.egressId, updatedAt: sql`now()` })
        .where(eq(recordings.id, id))
    } catch (error) {
      await RecordingService.markFailed(id, error instanceof Error ? error.message : String(error))
      throw errors.unavailable('Медиасервер не начал запись')
    }

    const row = await loadRecording(db(), id)
    if (!row) throw errors.internal('Запись создана, но не читается')
    return toRecord(row, { canStop: true })
  },

  /** Остановить запись: файл медиасервер доложит вебхуком. */
  async stop(ctx: UserCtx, recordingId: string): Promise<RecordingRecord> {
    const row = await loadRecording(db(), recordingId)
    if (!row) throw errors.notFound('Запись')
    await assertCanRecord(ctx, row.meetingId)
    if (row.status !== 'starting' && row.status !== 'active') {
      throw errors.conflict('Запись не идёт', { status: row.status })
    }
    await db().transaction((tx) => finishEgress(tx, ctx, row, 'manual'))
    const updated = await loadRecording(db(), recordingId)
    if (!updated) throw errors.internal('Запись не читается')
    return toRecord(updated, { canStop: false })
  },

  /**
   * Идущие записи встречи останавливаются вместе с ней: «идущая» запись не
   * должна пережить свою комнату. Вызывается в транзакции завершения встречи.
   */
  async stopActive(tx: Executor, ctx: Ctx, meetingId: string): Promise<void> {
    const rows = (await selectRecordings(tx).where(
      and(eq(recordings.meetingId, meetingId), inArray(recordings.status, ['starting', 'active'])),
    )) as RecordingRow[]
    for (const row of rows) await finishEgress(tx, ctx, row, 'meeting_ended')
  },

  async get(ctx: UserCtx, recordingId: string): Promise<RecordingRecord> {
    await authorize(ctx, 'view', recordingId)
    let row = await loadRecording(db(), recordingId)
    if (!row) throw errors.notFound('Запись')
    row = (await reconcile(row)) ?? row
    const canStop = hasCapability(ctx, RECORD_CAPABILITY)
      ? (await authorize(ctx, 'end', row.meetingId, { soft: true })).allowed
      : false
    const canPin = (await authorize(ctx, 'edit', recordingId, { soft: true })).allowed
    const expires = await retentionOf([row])
    return toRecord(row, { canStop, canPin, expiresAt: expires(row) })
  },

  /**
   * Закрепить запись от удаления по сроку хранения или открепить (N29,
   * ADR-0138) — организатор. Предупреждение о сроке после этого — заново.
   */
  async pin(ctx: UserCtx, recordingId: string, pinned: boolean): Promise<RecordingRecord> {
    await authorize(ctx, 'edit', recordingId)
    const row = await loadRecording(db(), recordingId)
    if (!row) throw errors.notFound('Запись')
    if (row.status !== 'ready' && row.status !== 'failed') {
      throw errors.conflict('Запись ещё идёт', { status: row.status })
    }
    await db().transaction(async (tx) => {
      await tx
        .update(recordings)
        .set({
          pinnedAt: pinned ? sql`now()` : null,
          pinnedBy: pinned ? (ctx.onBehalfOf ?? ctx.userId) : null,
          retentionWarnedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(recordings.id, recordingId))
      await publishEvent(tx, ctx, {
        type: 'recording.pinned',
        object: {
          id: recordingId,
          type: 'recording',
          spaceId: await meetingsSpaceId(tx),
          title: row.title,
        },
        payload: { meetingId: row.meetingId, pinned },
      })
    })
    return RecordingService.get(ctx, recordingId)
  },

  /** Записи встречи: доступны тем же, кому доступна сама встреча. */
  async list(ctx: UserCtx, meetingId: string): Promise<RecordingRecord[]> {
    await authorize(ctx, 'view', meetingId)
    const rows = (await selectRecordings(db())
      .where(eq(recordings.meetingId, meetingId))
      .orderBy(desc(recordings.createdAt))) as RecordingRow[]
    const canStop = hasCapability(ctx, RECORD_CAPABILITY)
      ? (await authorize(ctx, 'end', meetingId, { soft: true })).allowed
      : false
    const expires = await retentionOf(rows)
    const items: RecordingRecord[] = []
    for (const row of rows) {
      const current = (await reconcile(row)) ?? row
      const canPin = (await authorize(ctx, 'edit', row.id, { soft: true })).allowed
      items.push(await toRecord(current, { canStop, canPin, expiresAt: expires(current) }))
    }
    return items
  },

  /** Индикатор записи в карточке встречи: её видят все участники. */
  async liveFor(
    meetingId: string,
    executor: Executor = db(),
  ): Promise<{ id: string; status: RecordingStatus; startedAt: string | null } | null> {
    const [row] = await executor
      .select({
        id: recordings.id,
        status: recordings.status,
        startedAt: recordings.startedAt,
      })
      .from(recordings)
      .where(
        and(
          eq(recordings.meetingId, meetingId),
          inArray(recordings.status, ['starting', 'active']),
        ),
      )
      .orderBy(desc(recordings.createdAt))
      .limit(1)
    return row ? { ...row, status: row.status as RecordingStatus } : null
  },

  /** Найти запись по заданию медиасервера — вебхук знает только его. */
  async byEgress(egressId: string): Promise<RecordingRow | null> {
    const [row] = await selectRecordings(db()).where(eq(recordings.egressId, egressId)).limit(1)
    return (row as RecordingRow | undefined) ?? null
  },

  /**
   * События медиасервера (подпись уже проверена). Интересны только события
   * записи: комната и участники ведутся самим api. Повторная доставка
   * безопасна — готовая запись второй раз не обрабатывается.
   */
  async onWebhook(event: WebhookEvent): Promise<{ handled: boolean }> {
    const info = event.egressInfo
    if (!info?.egressId) return { handled: false }
    const row = await RecordingService.byEgress(info.egressId)
    if (!row) return { handled: false }

    if (event.event === 'egress_started' || event.event === 'egress_updated') {
      // EGRESS_ACTIVE — запись действительно пошла
      if (info.status === 1 && row.status === 'starting') {
        await db()
          .update(recordings)
          .set({ status: 'active', updatedAt: sql`now()` })
          .where(eq(recordings.id, row.id))
      }
      return { handled: true }
    }
    if (event.event !== 'egress_ended') return { handled: false }

    // EGRESS_COMPLETE — файл на месте; остальное (FAILED, ABORTED, LIMIT_REACHED) — сбой
    const file = fileResultOf(info)
    if (info.status === 3 && (file.storageKey || row.storageKey)) {
      await RecordingService.markReady(row.id, file)
    } else {
      await RecordingService.markFailed(row.id, info.error || 'медиасервер не сохранил запись')
    }
    return { handled: true }
  },

  async markFailed(recordingId: string, error: string): Promise<void> {
    const row = await loadRecording(db(), recordingId)
    if (!row || row.status === 'ready' || row.status === 'failed') return
    const ctx = systemCtx('meetings.recording')
    await db().transaction(async (tx) => {
      await tx
        .update(recordings)
        .set({
          status: 'failed',
          error: error.slice(0, 2000),
          endedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(recordings.id, recordingId))
      await publishEvent(tx, ctx, {
        type: 'recording.failed',
        object: { id: recordingId, type: 'recording', spaceId: null, title: row.title },
        payload: { meetingId: row.meetingId, error: error.slice(0, 500) },
      })
    })
    log().warn({ recordingId, error }, 'запись встречи не удалась')
  },

  /**
   * Медиасервер доложил файл: он уже лежит под выданным ключом, поэтому здесь
   * только объект файла реестра (вложение записи), длительность и задание
   * расшифровки — всё в одной транзакции с событием `recording.ready`.
   */
  async markReady(
    recordingId: string,
    result: { storageKey: string | null; sizeBytes: number | null; durationSeconds: number | null },
  ): Promise<void> {
    const row = await loadRecording(db(), recordingId)
    if (!row) return
    if (row.status === 'ready') return
    const ctx = systemCtx('meetings.recording', {
      ...(row.startedBy ? { initiatorId: row.startedBy } : {}),
    })
    const fileId = newId()
    const versionId = newId()
    const storageKey = result.storageKey ?? row.storageKey
    await db().transaction(async (tx) => {
      const spaceId = await meetingsSpaceId(tx)
      await registerGeneratedFile(tx, ctx, {
        fileId,
        versionId,
        spaceId,
        name: recordingFileName(row.title),
        mime: RECORDING_MIME,
        size: result.sizeBytes ?? 0,
        storageKey,
        checksum: null,
        attachToObjectId: recordingId,
      })
      await tx
        .update(recordings)
        .set({
          status: 'ready',
          fileId,
          storageKey,
          sizeBytes: result.sizeBytes,
          durationS: result.durationSeconds,
          transcriptStatus: 'queued',
          endedAt: sql`coalesce(${recordings.endedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(eq(recordings.id, recordingId))
      await publishEvent(tx, ctx, {
        type: 'recording.ready',
        object: { id: recordingId, type: 'recording', spaceId, title: row.title },
        payload: {
          meetingId: row.meetingId,
          fileId,
          durationSeconds: result.durationSeconds,
          sizeBytes: result.sizeBytes,
        },
      })
      // Расшифровку считает движок; без модели распознавания он ответит
      // «функция недоступна», и это не сбой задания (ADR-0092)
      await JobService.schedule(tx, ctx, {
        queue: TRANSCRIBE_JOB.queue,
        name: TRANSCRIBE_JOB.name,
        objectId: recordingId,
        idempotencyKey: `transcribe:${recordingId}`,
        data: {
          recordingId,
          meetingId: row.meetingId,
          bucket: buckets.files(),
          storageKey,
        },
      })
    })
  },
}
