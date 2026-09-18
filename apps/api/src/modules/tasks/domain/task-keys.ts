import type { TaskKind } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { Executor } from '~/shared/db/client.js'
import { taskCounters } from '~/shared/db/schema/index.js'

/** Счётчик в строке `task_counters`: атомарно под блокировкой строки. */
async function nextSeq(tx: Executor, scope: string, year: number): Promise<number> {
  const [row] = await tx
    .insert(taskCounters)
    .values({ scope, year, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [taskCounters.scope, taskCounters.year],
      set: { lastSeq: sql`${taskCounters.lastSeq} + 1` },
    })
    .returning({ seq: taskCounters.lastSeq })
  if (!row) throw new Error('счётчик ключей задач не обновлён')
  return row.seq
}

/** Год по часам организации: ключ `П-26-…` меняется в полночь по Душанбе, а не по UTC. */
function currentYear(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en', { timeZone: config().TZ, year: 'numeric' }).format(now),
  )
}

/**
 * Ключ задачи (10-tasks-projects.md §1–2): в проекте — `FLD-12`, поручение
 * без проекта — `П-26-7`, задача без проекта — `З-26-3`. Счётчик меняется в
 * транзакции создания: параллельные создания ждут друг друга на строке
 * счётчика, откат не оставляет пропуска в номерах.
 */
export async function nextTaskKey(
  tx: Executor,
  input: { kind: TaskKind; project: { id: string; key: string } | null; now?: Date },
): Promise<string> {
  if (input.project) {
    return `${input.project.key}-${await nextSeq(tx, `project:${input.project.id}`, 0)}`
  }
  const year = currentYear(input.now ?? new Date())
  const yy = String(year % 100).padStart(2, '0')
  const instruction = input.kind === 'instruction'
  const seq = await nextSeq(tx, instruction ? 'instruction' : 'task', year)
  return `${instruction ? 'П' : 'З'}-${yy}-${seq}`
}
