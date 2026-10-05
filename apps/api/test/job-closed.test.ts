import type { EventEnvelope } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext, uploadFile } from './helpers.js'

/**
 * Закрытие записей модулей по сбою и отмене их заданий (ADR-0187): импорт, рендер,
 * PDF версии, обработка файла, анализ, колоночная копия, пайплайн, источник, отчёт,
 * расшифровка и запуск правила не остаются «в работе», когда задание отменено или
 * упало окончательно. Подписчики вызываются с событием из outbox, как в шине.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { JOB_CANCELLED_REASON, jobClosedSubscriber } = await import('../src/kernel/jobs/outcomes.js')
const { registerModulesBackground } = await import('../src/modules/index.js')
const { files } = await import('../src/modules/files/schema.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

/** Подписчики модулей, которые закрывают свою запись по заданию. */
const CLOSING_SUBSCRIBERS = [
  'automation-run-closed',
  'data-analysis-failed',
  'data-columnar-job',
  'data-import-failed',
  'data-pipeline-failed',
  'data-source-failed',
  'documents-pdf-failed',
  'documents-render-failed',
  'files-processing-failed',
  'meetings-transcribe-failed',
  'reports-run-failed',
]

async function closedEvent(
  jobId: string,
  type: 'job.cancelled' | 'job.failed',
): Promise<EventEnvelope> {
  const rows = await db().execute<{ event: EventEnvelope }>(
    sql`SELECT event FROM ops.outbox
         WHERE type = ${type} AND event->'payload'->>'jobId' = ${jobId}
         ORDER BY id DESC LIMIT 1`,
  )
  const event = rows[0]?.event
  if (!event) throw new Error(`нет события ${type} задания ${jobId}`)
  return event
}

function subscriber(name: string) {
  const found = bus.listSubscribers().find((item) => item.name === name)
  if (!found) throw new Error(`подписчик ${name} не зарегистрирован`)
  return found
}

beforeAll(async () => {
  fx = await setupFixture()
  if (!bus.listSubscribers().some((item) => item.name === 'files-processing-failed')) {
    registerModulesBackground()
  }
})

describe('закрытие записей по сбою и отмене заданий', () => {
  it('механизм: своё задание закрывается с причиной, чужое — нет', async () => {
    const kind = { queue: 'maintenance' as const, name: `test.closed.${run}` }
    const closed: Array<{ jobId: string; outcome: string; reason: string; marker: unknown }> = []
    const watcher = jobClosedSubscriber({
      name: `test-closed-${run}`,
      jobs: [kind],
      onClosed: async ({ job, outcome, reason, payload }) => {
        closed.push({ jobId: job.id, outcome, reason, marker: payload?.marker })
      },
    })
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })

    const cancelled = await JobService.enqueue(ctx, { ...kind, data: { marker: 'a' } })
    expect(await JobService.cancel(ctx, cancelled)).toBe('cancelled')
    await watcher.handle(await closedEvent(cancelled, 'job.cancelled'))

    const failed = await JobService.enqueue(ctx, { ...kind, data: { marker: 'b' } })
    await JobService.fail(failed, new Error('нет файла'), { final: true })
    await watcher.handle(await closedEvent(failed, 'job.failed'))

    const other = await JobService.enqueue(ctx, {
      queue: 'maintenance',
      name: `test.other.${run}`,
      data: {},
    })
    await JobService.cancel(ctx, other)
    await watcher.handle(await closedEvent(other, 'job.cancelled'))

    expect(closed).toEqual([
      { jobId: cancelled, outcome: 'cancelled', reason: JOB_CANCELLED_REASON, marker: 'a' },
      { jobId: failed, outcome: 'failed', reason: 'нет файла', marker: 'b' },
    ])
  })

  it('обработка файла: отмена задания движка закрывает превью и текст', async () => {
    const file = await uploadFile(fx.app, fx.users.member, {
      spaceId: fx.spaceId,
      name: `закрытие-${run}.txt`,
      content: 'текст для обработки',
    })
    const jobs = await db().execute<{ id: string }>(
      sql`SELECT id FROM jobs WHERE object_id = ${file.id} AND name = 'file.process'
           ORDER BY created_at DESC LIMIT 1`,
    )
    const jobId = jobs[0]?.id
    if (!jobId) throw new Error('нет задания обработки файла')
    expect(await JobService.cancel(systemCtx('test'), jobId)).toBe('cancelled')

    await subscriber('files-processing-failed').handle(await closedEvent(jobId, 'job.cancelled'))

    const [row] = await db()
      .select({ previewStatus: files.previewStatus, textStatus: files.textStatus })
      .from(files)
      .where(eq(files.id, file.id))
    expect(row).toEqual({ previewStatus: 'failed', textStatus: 'failed' })
  })

  it('каждый подписчик закрытия модуля слушает и сбой, и отмену', () => {
    for (const name of CLOSING_SUBSCRIBERS) {
      expect(subscriber(name).types, name).toEqual(
        expect.arrayContaining(['job.failed', 'job.cancelled']),
      )
    }
  })
})
