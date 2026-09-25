import type { TranscriptRecord, TranscriptResult, TranscriptStatus } from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  meetingParticipants,
  meetings,
  objects,
  recordings,
  transcripts,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import type { TranscriptText } from './protocol-transcript.js'

/** Метки говорящих в порядке первого появления в расшифровке. */
function speakerLabels(segments: ReadonlyArray<{ speaker: string | null }>): string[] {
  const labels: string[] = []
  for (const segment of segments) {
    if (segment.speaker && !labels.includes(segment.speaker)) labels.push(segment.speaker)
  }
  return labels
}

/** Имена сопоставленных участников: метка → имя, для протокола и выгрузки. */
async function speakerNames(speakers: Record<string, string>): Promise<Map<string, string>> {
  const refs = await directory().refs([...new Set(Object.values(speakers))])
  const names = new Map<string, string>()
  for (const [label, userId] of Object.entries(speakers)) {
    const user = refs.get(userId)
    if (user) names.set(label, user.displayName)
  }
  return names
}

/**
 * Расшифровка под правку: строка блокируется до конца транзакции, чтобы две
 * одновременные правки разных фраз не затёрли одна другую.
 */
async function lockedTranscript(tx: Executor, recordingId: string) {
  const [row] = await tx
    .select({
      segments: transcripts.segments,
      speakers: transcripts.speakers,
      meetingId: recordings.meetingId,
      title: objects.title,
      spaceId: objects.spaceId,
    })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .innerJoin(objects, eq(objects.id, recordings.id))
    .where(eq(transcripts.recordingId, recordingId))
    .limit(1)
    .for('update', { of: transcripts })
  if (!row) throw errors.notFound('Расшифровка')
  return row
}

/**
 * Расшифровка записи встречи (11-communications-meetings.md §4, ADR-0092).
 * Сегменты считает движок заданием `media:media.transcribe`; здесь — хранение и
 * выдача. Доступ — как у записи: `view` на объекте записи, то есть участникам
 * встречи; постороннему запись не видна, а значит и расшифровка. Исправить
 * фразу и сопоставить говорящего может тот, у кого `edit` на записи (ADR-0162).
 */
export const TranscriptService = {
  async get(ctx: UserCtx, recordingId: string): Promise<TranscriptRecord> {
    await authorize(ctx, 'view', recordingId)
    const [recording] = await db()
      .select({
        status: recordings.transcriptStatus,
        error: recordings.error,
        durationS: recordings.durationS,
      })
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1)
    if (!recording) throw errors.notFound('Запись')
    const [row] = await db()
      .select({
        language: transcripts.language,
        model: transcripts.model,
        durationS: transcripts.durationS,
        segments: transcripts.segments,
        speakers: transcripts.speakers,
        editedAt: transcripts.editedAt,
        createdAt: transcripts.createdAt,
      })
      .from(transcripts)
      .where(eq(transcripts.recordingId, recordingId))
      .limit(1)
    const segments = row?.segments ?? []
    const mapping = row?.speakers ?? {}
    const users = await directory().refs([...new Set(Object.values(mapping))])
    const canEdit = row
      ? (await authorize(ctx, 'edit', recordingId, { soft: true })).allowed
      : false
    return {
      recordingId,
      status: recording.status as TranscriptStatus,
      language: row?.language ?? null,
      model: row?.model ?? null,
      durationSeconds: row?.durationS ?? recording.durationS ?? null,
      segments: segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        speaker: segment.speaker ?? null,
        edited: segment.edited === true,
        original: segment.edited === true ? (segment.original ?? null) : null,
      })),
      speakers: speakerLabels(segments).map((label) => {
        const userId = mapping[label]
        return { label, user: userId ? (users.get(userId) ?? null) : null }
      }),
      error: recording.status === 'failed' ? recording.error : null,
      createdAt: row?.createdAt ?? null,
      editedAt: row?.editedAt ?? null,
      can: { edit: canEdit },
    }
  },

  /**
   * Исправление текста фразы (ADR-0162): таймкоды и говорящий остаются, у
   * фразы — пометка «исправлено» и исходный текст распознавания. Возврат к
   * исходному тексту снимает пометку.
   */
  async editSegment(
    ctx: UserCtx,
    recordingId: string,
    index: number,
    text: string,
  ): Promise<TranscriptRecord> {
    await authorize(ctx, 'edit', recordingId)
    await db().transaction(async (tx) => {
      const row = await lockedTranscript(tx, recordingId)
      const segment = row.segments[index]
      if (!segment) throw errors.notFound('Фраза расшифровки')
      if (segment.text === text) return
      const original = segment.edited ? (segment.original ?? segment.text) : segment.text
      const next = row.segments.map((item, at) => {
        if (at !== index) return item
        const { edited: _edited, original: _original, ...rest } = item
        return text === original ? { ...rest, text } : { ...rest, text, edited: true, original }
      })
      await tx
        .update(transcripts)
        .set({ segments: next, editedAt: sql`now()`, editedBy: ctx.userId })
        .where(eq(transcripts.recordingId, recordingId))
      await publishEvent(tx, ctx, {
        type: 'transcript.edited',
        object: { id: recordingId, type: 'recording', spaceId: row.spaceId, title: row.title },
        payload: {
          meetingId: row.meetingId,
          recordingId,
          change: 'segment',
          segment: index,
          label: null,
          userId: null,
        },
      })
    })
    return TranscriptService.get(ctx, recordingId)
  },

  /**
   * Сопоставление метки говорящего с участником встречи (ADR-0162). Участник —
   * организатор или приглашённый: чужое имя в расшифровку не попадёт.
   * `userId: null` снимает сопоставление.
   */
  async setSpeaker(
    ctx: UserCtx,
    recordingId: string,
    label: string,
    userId: string | null,
  ): Promise<TranscriptRecord> {
    await authorize(ctx, 'edit', recordingId)
    await db().transaction(async (tx) => {
      const row = await lockedTranscript(tx, recordingId)
      if (!speakerLabels(row.segments).includes(label)) {
        throw errors.validation('Такого говорящего в расшифровке нет')
      }
      if (userId) {
        const [organizer] = await tx
          .select({ id: meetings.id })
          .from(meetings)
          .where(and(eq(meetings.id, row.meetingId), eq(meetings.organizerId, userId)))
          .limit(1)
        const [participant] = organizer
          ? [organizer]
          : await tx
              .select({ id: meetingParticipants.userId })
              .from(meetingParticipants)
              .where(
                and(
                  eq(meetingParticipants.meetingId, row.meetingId),
                  eq(meetingParticipants.userId, userId),
                ),
              )
              .limit(1)
        if (!participant)
          throw errors.validation('Говорящим можно указать только участника встречи')
      }
      if ((row.speakers[label] ?? null) === userId) return
      const next = { ...row.speakers }
      if (userId) next[label] = userId
      else delete next[label]
      await tx
        .update(transcripts)
        .set({ speakers: next, editedAt: sql`now()`, editedBy: ctx.userId })
        .where(eq(transcripts.recordingId, recordingId))
      await publishEvent(tx, ctx, {
        type: 'transcript.edited',
        object: { id: recordingId, type: 'recording', spaceId: row.spaceId, title: row.title },
        payload: {
          meetingId: row.meetingId,
          recordingId,
          change: 'speaker',
          segment: null,
          label,
          userId,
        },
      })
    })
    return TranscriptService.get(ctx, recordingId)
  },

  /**
   * Итог задания движка. `unavailable` — модель распознавания не настроена:
   * функция выключена, задание при этом выполнено.
   */
  async save(recordingId: string, result: TranscriptResult): Promise<void> {
    const [row] = await db()
      .select({ meetingId: recordings.meetingId, title: objects.title })
      .from(recordings)
      .innerJoin(objects, eq(objects.id, recordings.id))
      .where(eq(recordings.id, recordingId))
      .limit(1)
    if (!row) throw errors.notFound('Запись')
    const ctx = systemCtx('meetings.transcript')
    const object = {
      id: recordingId,
      type: 'recording' as const,
      spaceId: null,
      title: row.title,
    }

    await db().transaction(async (tx) => {
      if (result.status === 'ready') {
        await tx
          .insert(transcripts)
          .values({
            id: newId(),
            recordingId,
            language: result.language,
            model: result.model,
            durationS: result.durationSeconds === null ? null : Math.round(result.durationSeconds),
            segments: result.segments.map((segment) => ({
              start: segment.start,
              end: segment.end,
              text: segment.text,
              speaker: segment.speaker,
            })),
          })
          .onConflictDoUpdate({
            target: transcripts.recordingId,
            set: {
              language: result.language,
              model: result.model,
              durationS:
                result.durationSeconds === null ? null : Math.round(result.durationSeconds),
              segments: result.segments.map((segment) => ({
                start: segment.start,
                end: segment.end,
                text: segment.text,
                speaker: segment.speaker,
              })),
              createdAt: sql`now()`,
            },
          })
        await tx
          .update(recordings)
          .set({ transcriptStatus: 'ready', updatedAt: sql`now()` })
          .where(eq(recordings.id, recordingId))
        await publishEvent(tx, ctx, {
          type: 'transcript.ready',
          object,
          payload: {
            meetingId: row.meetingId,
            recordingId,
            language: result.language,
            segments: result.segments.length,
          },
        })
        return
      }

      const status: TranscriptStatus = result.status === 'unavailable' ? 'unavailable' : 'failed'
      await tx
        .update(recordings)
        .set({
          transcriptStatus: status,
          ...(result.error ? { error: result.error.slice(0, 2000) } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(recordings.id, recordingId))
      await publishEvent(tx, ctx, {
        type: 'transcript.failed',
        object,
        payload: {
          meetingId: row.meetingId,
          recordingId,
          reason: result.status === 'unavailable' ? 'unavailable' : 'failed',
          error: result.error,
        },
      })
    })
  },

  /**
   * Текст последней готовой расшифровки встречи — источник для черновика
   * протокола (ADR-0093). Права здесь не проверяются: порт зовёт черновик уже
   * после `authorize()` на протоколе, а протокол и запись видит один круг —
   * участники встречи.
   */
  async textOf(meetingId: string, limit: number): Promise<TranscriptText | null> {
    const [row] = await db()
      .select({
        segments: transcripts.segments,
        speakers: transcripts.speakers,
        recordingId: transcripts.recordingId,
      })
      .from(transcripts)
      .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
      .where(and(eq(recordings.meetingId, meetingId), eq(recordings.transcriptStatus, 'ready')))
      .orderBy(desc(transcripts.createdAt))
      .limit(1)
    if (!row) return null

    // Сопоставленный говорящий попадает в черновик по имени (ADR-0162)
    const names = await speakerNames(row.speakers)
    let text = ''
    let truncated = false
    for (const segment of row.segments) {
      const phrase = segment.text.trim()
      if (!phrase) continue
      const speaker = segment.speaker ? (names.get(segment.speaker) ?? segment.speaker) : null
      const line = speaker ? `${speaker}: ${phrase}` : phrase
      if (text.length + line.length + 1 > limit) {
        truncated = true
        break
      }
      text += text ? `\n${line}` : line
    }
    return { text, truncated, recordingId: row.recordingId }
  },
}
