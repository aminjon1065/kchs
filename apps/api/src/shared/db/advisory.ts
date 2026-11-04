import { lockSql } from './client.js'

/** Ключи advisory-блокировок платформы — в одном месте, чтобы не совпали. */
export const ADVISORY_LOCKS = {
  /** Мигратор (`migrate.ts`). */
  migrations: 725_130_001,
  /** Приведение таблиц модулей к текущему виду при старте (ADR-0173). */
  storageUpgrade: 725_130_002,
  /** Партиции журнала аудита (`partitions.ts`). */
  auditPartitions: 725_130_003,
  /** Одиночные задания (`kernel/jobs/exclusive.ts`, ADR-0228): второй ключ — хэш имени. */
  singleJob: 725_130_004,
} as const

/**
 * Работа, которую одновременно должна делать только одна реплика, — например,
 * приведение таблиц датасетов к текущему виду при старте (ADR-0173). Сессионная
 * блокировка держится на отдельном соединении; остальные реплики ждут и затем
 * видят сделанное: их проверки находят, что делать нечего.
 */
export async function withAdvisoryLock<T>(key: number, run: () => Promise<T>): Promise<T> {
  const connection = await lockSql().reserve()
  try {
    await connection`SELECT pg_advisory_lock(${key})`
    try {
      return await run()
    } finally {
      await connection`SELECT pg_advisory_unlock(${key})`
    }
  } finally {
    connection.release()
  }
}
