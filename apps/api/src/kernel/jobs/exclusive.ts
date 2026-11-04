import { ADVISORY_LOCKS } from '~/shared/db/advisory.js'
import { rawSql } from '~/shared/db/client.js'

/**
 * Одиночное задание (ADR-0228): одновременно идёт не больше одного исполнения на
 * всю установку — во всех процессах worker и при любом числе слотов очереди.
 * Сессионная advisory-блокировка держится на отдельном соединении, пока обработчик
 * действительно работает: даже если предел времени освободил слот очереди, второе
 * исполнение не начнётся, пока первое не закончилось. Процесс упал — соединение
 * закрыто, блокировка снята сама.
 */
export interface HeldJobLock {
  release: () => Promise<void>
}

export async function tryJobLock(key: string): Promise<HeldJobLock | null> {
  const connection = await rawSql().reserve()
  try {
    const [row] = await connection<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCKS.singleJob}::int, hashtext(${key})) AS locked`
    if (!row?.locked) {
      connection.release()
      return null
    }
  } catch (error) {
    connection.release()
    throw error
  }
  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      try {
        await connection`
          SELECT pg_advisory_unlock(${ADVISORY_LOCKS.singleJob}::int, hashtext(${key}))`
      } finally {
        connection.release()
      }
    },
  }
}
