/**
 * Публичный API модуля «Документы» для других модулей (01-overview.md §Как
 * модули взаимодействуют; ADR-0080). Точки расширения второй волны:
 *  - движок процессов меняет статус документа только через `applyTransition`
 *    (граф 08-documents.md §3, событие `document.status_changed`) и выдаёт
 *    участникам маршрута права через `setParticipants(…, 'route:<экземпляр>', …)`;
 *  - резолюции получают реквизиты `brief` и выдают исполнителям право
 *    чтения через `setParticipants(…, 'resolution:<id>', …)`;
 *  - шаг маршрута `register` вызывает `register` (номер из журнала типа).
 * Каждая функция принимает контекст и проверяет права сама (16-api-and-events.md §4).
 */
import type { DocumentRegisterInput, DocumentStatus } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { DocumentService } from './domain/document-service.js'
import { applyTransition, type TransitionInput } from './domain/lifecycle.js'
import { DocumentParticipants, type ParticipantEntry } from './domain/participants.js'
import { ensureStarterSet } from './domain/starter-set.js'

/** @public — вход перехода жизненного цикла для движка процессов (вторая волна) */
export type { TransitionInput } from './domain/lifecycle.js'
/** @public — типы точек расширения для движка процессов и резолюций (вторая волна) */
export type { ParticipantEntry, ParticipantRole } from './domain/participants.js'

/** @public — точки расширения второй волны: маршруты, резолюции, печатные формы */
export const DocumentsPublic = {
  /**
   * Переход жизненного цикла (08-documents.md §3) в транзакции вызывающего.
   * @public — движок процессов второй волны (маршруты согласования и подписи)
   */
  applyTransition: (
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: TransitionInput,
  ): Promise<{ from: DocumentStatus; to: DocumentStatus }> =>
    applyTransition(tx, ctx, documentId, input),

  /**
   * Участники одного источника (`route:<экземпляр>`, `resolution:<id>`): тихие
   * записи ACL с максимальным уровнем по всем источникам.
   * @public — участники маршрута и исполнители резолюций (вторая волна)
   */
  setParticipants: (
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    source: string,
    entries: ParticipantEntry[],
  ): Promise<{ added: string[]; removed: string[] }> =>
    DocumentParticipants.sync(tx, ctx, documentId, source, entries),

  /**
   * Регистрация шагом маршрута `register` (номер из журнала типа или резерва).
   * @public — движок процессов второй волны
   */
  register: (
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: DocumentRegisterInput = {},
  ): Promise<string> => DocumentService.register(tx, ctx, documentId, input),

  /**
   * Реквизиты документа без проверки прав — для кода, который уже проверил
   * `authorize(view)` (резолюции, печатные формы). Null — документа нет.
   * @public — резолюции и печатные формы (вторая волна)
   */
  brief: async (executor: Executor, documentId: string) => {
    const row = await DocumentService.load(executor, documentId)
    if (!row) return null
    return {
      id: row.id,
      typeId: row.typeId,
      status: row.status as DocumentStatus,
      subject: row.subject,
      regNumber: row.regNumber,
      regDate: row.regDate,
      responsibleId: row.responsibleId,
      controllerId: row.controllerId,
      deadline: row.deadline,
      control: row.control,
      confidentiality: row.confidentiality,
      spaceId: row.spaceId,
    }
  },
}

/** Стартовые журналы, типы и (демо) корреспонденты — `kchs init` и `db:seed`. */
export const DocumentsSeed = { ensureStarterSet }
