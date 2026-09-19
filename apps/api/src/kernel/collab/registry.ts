import type { ObjectType } from '@kchs/contracts'
import type * as Y from 'yjs'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'

/**
 * Тип объекта с совместным редактированием (ADR-0070). Модуль регистрирует его
 * при старте, как тип объекта: ядро хранит состояние Yjs и проверяет права, а
 * что лежит в документе и как его читать — знает только модуль.
 */
export interface CollabTypeDefinition {
  type: ObjectType
  /**
   * Начальное состояние документа, если в `yjs.documents` его ещё нет (объект
   * создан до совместной правки). Должно быть детерминированным: два процесса,
   * открывшие документ одновременно, получат одинаковые операции Yjs.
   */
  initialState?: (objectId: string, executor: Executor) => Promise<Uint8Array | null>
  /**
   * Снимок тела в JSON — в той же транзакции, что и состояние Yjs: модуль пишет
   * свою таблицу, версию объекта и доменное событие. Документ пишут клиенты —
   * снимок не доверяет его содержимому и не бросает исключений из-за него.
   */
  snapshot: (tx: Executor, ctx: Ctx, objectId: string, doc: Y.Doc) => Promise<void>
}

/** Канал Redis: подписчик событий (worker) просит api перепроверить подключения к объекту. */
export const COLLAB_CHANNEL = 'rt:collab'

const registry = new Map<string, CollabTypeDefinition>()

export function registerCollabType(definition: CollabTypeDefinition): void {
  if (registry.has(definition.type)) {
    throw new Error(`Совместное редактирование типа «${definition.type}» уже зарегистрировано`)
  }
  registry.set(definition.type, definition)
}

export function collabType(type: string): CollabTypeDefinition | undefined {
  return registry.get(type)
}
