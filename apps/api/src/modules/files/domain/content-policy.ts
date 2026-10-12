import { FILE_FROZEN } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor, Tx } from '~/shared/db/client.js'
import { AppError } from '~/shared/errors.js'

/** Как появилась новая версия файла. */
export type FileVersionSource = 'upload' | 'editor' | 'restore'

/** Почему содержимое файла сейчас менять нельзя и чей это объект. */
export interface FrozenFile {
  /** Ключ причины для текста интерфейса (`documents.versions.frozen.<reason>`). */
  reason: string
  /** Объект, который держит файл замороженным (документ): туда кладётся правка-копия. */
  hostId: string
}

/**
 * Политика содержимого файла (ADR-0197) — порт модуля файлов для модулей выше:
 * файл может входить в утверждённую версию документа, и тогда его байты менять
 * нельзя. Модуль файлов не знает документов: он спрашивает зарегистрированные
 * политики в момент действия (ADR-0123) и сообщает им о новой версии в той же
 * транзакции.
 */
export interface FileContentPolicy {
  /** Имя политики — для журнала и тестов. */
  key: string
  /** Какие из файлов заморожены: файл → причина и объект-хозяин. */
  frozen: (executor: Executor, fileIds: string[]) => Promise<Map<string, FrozenFile>>
  /**
   * Новая версия файла записана (загрузка, редактор, восстановление) — в
   * транзакции записи. Политика может ещё раз проверить своё правило под
   * блокировкой и отказать (409): тогда новая версия не сохранится.
   */
  versionAdded?: (
    tx: Tx,
    ctx: Ctx,
    input: { fileId: string; versionId: string; number: number; source: FileVersionSource },
  ) => Promise<void>
}

const policies = new Map<string, FileContentPolicy>()

/** Регистрация политики модулем при старте (по ключу: повтор заменяет прежнюю). */
export function registerFileContentPolicy(policy: FileContentPolicy): void {
  policies.set(policy.key, policy)
}

/** Замороженные файлы из списка — по всем политикам. */
export async function frozenFiles(
  executor: Executor,
  fileIds: string[],
): Promise<Map<string, FrozenFile>> {
  const result = new Map<string, FrozenFile>()
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return result
  for (const policy of policies.values()) {
    for (const [fileId, frozen] of await policy.frozen(executor, ids)) {
      if (!result.has(fileId)) result.set(fileId, frozen)
    }
  }
  return result
}

const FROZEN_MESSAGE =
  'Файл входит в согласованную или подписанную версию документа — его содержимое не меняется'

/** Ошибка «файл заморожен»: интерфейс узнаёт её по `data.reason`. */
export function fileFrozenError(
  fileId: string,
  frozen: FrozenFile,
  message = FROZEN_MESSAGE,
): AppError {
  return new AppError('conflict', message, 409, {
    data: { reason: FILE_FROZEN, cause: frozen.reason, fileId, hostId: frozen.hostId },
  })
}

/** Содержимое файла можно менять — иначе 409 `file_frozen`. */
export async function assertFileChangeable(
  executor: Executor,
  fileId: string,
  message?: string,
): Promise<void> {
  const frozen = (await frozenFiles(executor, [fileId])).get(fileId)
  if (frozen) throw fileFrozenError(fileId, frozen, message)
}

/** Сообщить политикам о новой версии файла — в транзакции записи. */
export async function notifyVersionAdded(
  tx: Tx,
  ctx: Ctx,
  input: { fileId: string; versionId: string; number: number; source: FileVersionSource },
): Promise<void> {
  for (const policy of policies.values()) {
    if (policy.versionAdded) await policy.versionAdded(tx, ctx, input)
  }
}
