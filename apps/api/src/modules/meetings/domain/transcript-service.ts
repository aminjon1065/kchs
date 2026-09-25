import type { TranscriptRecord, TranscriptResult, TranscriptStatus } from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, recordings, transcripts } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import type { TranscriptText } from './protocol-transcript.js'

/**
 * Расшифровка записи встречи (11-communications-meetings.md §4, ADR-0092).
 * Сегменты считает движок заданием `media:media.transcribe`; здесь — хранение и
 * выдача. Доступ — как у записи: `view` на объекте записи, то есть участникам
 * встречи; постороннему запись не видна, а значит и расшифровка.
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
        createdAt: transcripts.createdAt,
      })
      .from(transcripts)
      .where(eq(transcripts.recordingId, recordingId))
      .limit(1)
    return {
      recordingId,
      status: recording.status as TranscriptStatus,
      language: row?.language ?? null,
      model: row?.model ?? null,
      durationSeconds: row?.durationS ?? recording.durationS ?? null,
      segments: (row?.segments ?? []).map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        speaker: segment.speaker ?? null,
      })),
      error: recording.status === 'failed' ? recording.error : null,
      createdAt: row?.createdAt ?? null,
    }
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
      .select({ segments: transcripts.segments, recordingId: transcripts.recordingId })
      .from(transcripts)
      .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
      .where(and(eq(recordings.meetingId, meetingId), eq(recordings.transcriptStatus, 'ready')))
      .orderBy(desc(transcripts.createdAt))
      .limit(1)
    if (!row) return null

    let text = ''
    let truncated = false
    for (const segment of row.segments) {
      const phrase = segment.text.trim()
      if (!phrase) continue
      const line = segment.speaker ? `${segment.speaker}: ${phrase}` : phrase
      if (text.length + line.length + 1 > limit) {
        truncated = true
        break
      }
      text += text ? `\n${line}` : line
    }
    return { text, truncated, recordingId: row.recordingId }
  },
}
