import {
  type LinkKind,
  MeetingSettings,
  RECORDING_RETENTION_DEFAULT_MONTHS,
  RECORDING_RETENTION_WARNING_DAYS,
} from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SettingsService } from '~/kernel/settings/service.js'
import { deleteObject } from '~/kernel/storage/s3.js'
import { destroyFiles } from '~/modules/files/public.js'
import { type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { meetings, objects, recordings } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'

/** Ключ системной настройки срока хранения записей (N29, ADR-0138). */
const RETENTION_KEY = 'meetings.recordingRetentionMonths'
const DAY_MS = 86_400_000
const WARNING_MS = RECORDING_RETENTION_WARNING_DAYS * DAY_MS
/** Запись, связанная с протоколом или документом, «попала в протокол или дело». */
const KEEPING_TYPES = new Set(['protocol', 'document'])
const KEEPING_LINKS: readonly LinkKind[] = ['related', 'attachment', 'source', 'in_execution_of']
/** За один проход — не больше: задание ежедневное, хвост уйдёт завтра. */
const BATCH = 500

/**
 * Настройки встреч установки: срок хранения записей в месяцах (0 — бессрочно).
 * Испорченное значение заменяется умолчанием, правка — в аудит.
 */
export const MeetingSettingsService = {
  async current(): Promise<MeetingSettings> {
    const raw = await SettingsService.get<unknown>(
      RETENTION_KEY,
      [{ scope: 'system' }],
      RECORDING_RETENTION_DEFAULT_MONTHS,
    )
    const parsed = MeetingSettings.shape.recordingRetentionMonths.safeParse(raw)
    return {
      recordingRetentionMonths: parsed.success ? parsed.data : RECORDING_RETENTION_DEFAULT_MONTHS,
    }
  },

  async update(tx: Executor, ctx: Ctx, next: MeetingSettings): Promise<MeetingSettings> {
    const before = await MeetingSettingsService.current()
    await SettingsService.set(tx, ctx, 'system', null, RETENTION_KEY, next.recordingRetentionMonths)
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.settingsChanged,
        details: {
          key: RETENTION_KEY,
          before: before.recordingRetentionMonths,
          after: next.recordingRetentionMonths,
        },
        severity: 'notice',
      },
      tx,
    )
    return next
  },
}

export interface RetentionRow {
  id: string
  status: string
  endedAt: string | null
  createdAt: string
  pinnedAt: string | null
  retentionWarnedAt: string | null
}

/**
 * Когда запись удалится по сроку: конец записи плюс срок хранения, но не
 * раньше недели после предупреждения организатора. Null — не удалится.
 */
export function expiryOf(row: RetentionRow, months: number, kept: boolean): Date | null {
  if (months <= 0 || kept || row.pinnedAt) return null
  if (row.status !== 'ready' && row.status !== 'failed') return null
  const due = new Date(row.endedAt ?? row.createdAt)
  due.setUTCMonth(due.getUTCMonth() + months)
  if (!row.retentionWarnedAt) return due
  return new Date(Math.max(due.getTime(), Date.parse(row.retentionWarnedAt) + WARNING_MS))
}

/** Записи, связанные с протоколом или документом, — попали в протокол или дело: не удаляются. */
export async function keptByLinks(ids: readonly string[], executor: Executor = db()) {
  const kept = new Set<string>()
  if (ids.length === 0) return kept
  const wanted = new Set(ids)
  const linked = new Map<string, string[]>()
  for (const kind of KEEPING_LINKS) {
    for (const edge of await LinkService.edges([...ids], kind, executor)) {
      if (wanted.has(edge.sourceId)) {
        linked.set(edge.sourceId, [...(linked.get(edge.sourceId) ?? []), edge.targetId])
      }
      if (wanted.has(edge.targetId)) {
        linked.set(edge.targetId, [...(linked.get(edge.targetId) ?? []), edge.sourceId])
      }
    }
  }
  const others = [...new Set([...linked.values()].flat())]
  if (others.length === 0) return kept
  const summaries = await ObjectService.summaries(others, executor)
  for (const [id, list] of linked) {
    if (list.some((other) => KEEPING_TYPES.has(summaries.get(other)?.type ?? ''))) kept.add(id)
  }
  return kept
}

interface Candidate extends RetentionRow {
  meetingId: string
  fileId: string | null
  storageKey: string
  title: string
  spaceId: string | null
  organizerId: string | null
}

async function warn(row: Candidate, expiry: Date, now: Date): Promise<void> {
  const ctx = systemCtx('meetings.retention')
  await db().transaction(async (tx) => {
    await tx
      .update(recordings)
      .set({ retentionWarnedAt: now.toISOString(), updatedAt: sql`now()` })
      .where(eq(recordings.id, row.id))
    await publishEvent(tx, ctx, {
      type: 'recording.retention_warned',
      object: { id: row.id, type: 'recording', spaceId: row.spaceId, title: row.title },
      payload: { meetingId: row.meetingId, expiresAt: expiry.toISOString() },
    })
  })
  if (!row.organizerId) return
  // Удалится не раньше чем через неделю после этого предупреждения
  const date = new Date(Math.max(expiry.getTime(), now.getTime() + WARNING_MS))
  await NotificationService.notify({
    userIds: [row.organizerId],
    category: 'meetings',
    titleKey: 'notifications.tpl.recordingExpiring',
    params: { title: row.title, date: formatDate(date.toISOString(), { locale: 'ru' }) },
    objectId: row.id,
    url: `/o/${row.id}`,
  })
}

async function remove(row: Candidate): Promise<void> {
  const ctx = systemCtx('meetings.retention')
  await db().transaction(async (tx) => {
    // Файл записи и его байты в хранилище — вместе с объектом записи
    if (row.fileId) await destroyFiles(tx, ctx, [row.fileId])
    await publishEvent(tx, ctx, {
      type: 'recording.expired',
      object: { id: row.id, type: 'recording', spaceId: row.spaceId, title: row.title },
      payload: { meetingId: row.meetingId, fileId: row.fileId },
    })
    await ObjectService.purge(tx, ctx, row.id)
  })
  // Файла в реестре нет (запись не удалась) — остаток медиасервера по ключу
  if (!row.fileId) await deleteObject(row.storageKey)
}

/**
 * Срок хранения записей (N29, ADR-0138) — ежедневное задание: за неделю до
 * срока организатор получает предупреждение (закрепить запись можно в её
 * карточке), по сроку запись удаляется вместе с файлом, расшифровкой и байтами
 * в хранилище. Закреплённые и связанные с протоколом или документом — не трогаются.
 */
export const RecordingRetention = {
  async run(now: Date = new Date()): Promise<{ warned: number; deleted: number }> {
    const { recordingRetentionMonths: months } = await MeetingSettingsService.current()
    if (months <= 0) return { warned: 0, deleted: 0 }
    const horizon = new Date(now.getTime() + WARNING_MS).toISOString()
    const rows = (await db()
      .select({
        id: recordings.id,
        meetingId: recordings.meetingId,
        status: recordings.status,
        fileId: recordings.fileId,
        storageKey: recordings.storageKey,
        endedAt: recordings.endedAt,
        createdAt: recordings.createdAt,
        pinnedAt: recordings.pinnedAt,
        retentionWarnedAt: recordings.retentionWarnedAt,
        title: objects.title,
        spaceId: objects.spaceId,
        organizerId: meetings.organizerId,
      })
      .from(recordings)
      .innerJoin(objects, eq(objects.id, recordings.id))
      .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
      .where(
        and(
          isNull(recordings.pinnedAt),
          isNull(objects.deletedAt),
          inArray(recordings.status, ['ready', 'failed']),
          lte(
            sql`coalesce(${recordings.endedAt}, ${recordings.createdAt}) + make_interval(months => ${months})`,
            sql`${horizon}::timestamptz`,
          ),
        ),
      )
      .limit(BATCH)) as Candidate[]
    const kept = await keptByLinks(rows.map((row) => row.id))
    let warned = 0
    let deleted = 0
    for (const row of rows) {
      const expiry = expiryOf(row, months, kept.has(row.id))
      if (!expiry) continue
      try {
        if (!row.retentionWarnedAt) {
          await warn(row, expiry, now)
          warned += 1
        } else if (expiry.getTime() <= now.getTime()) {
          await remove(row)
          deleted += 1
        }
      } catch (error) {
        // Одна запись не мешает остальным: повтор — в завтрашнем проходе
        logger().warn({ err: error, recordingId: row.id }, 'срок хранения записи не применён')
      }
    }
    return { warned, deleted }
  },
}
