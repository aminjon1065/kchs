/**
 * Движок процессов ядра (02-platform-kernel.md §10, ADR-0012, ADR-0079) —
 * публичный API для модулей:
 *
 * - `ProcessService.start(tx, ctx, {objectId, definitionKey, variables})` —
 *   запуск маршрута в транзакции модуля; `completeStep` — модуль завершил
 *   шаг `task`/`call`; `running` — идущие маршруты объекта;
 * - `registerProcessObjectProvider` — данные типа объекта для назначений и
 *   условий, изменение поля (`set`), хуки активации, решения, завершения шага
 *   и маршрута (статус документа, заморозка версии, лист согласования);
 * - `registerProcessStepHandler` — исполнители шагов `register`, `task`,
 *   `call` модуля; `registerProcessWaitEvent` — события для шагов `wait`;
 * - `withProcessParticipants` — право участников шагов видеть объект в
 *   политике типа.
 *
 * О завершении маршрута модуль узнаёт хуком `onFinished` в той же транзакции
 * или событием `process.finished` через шину.
 */
import { registerProcessInboxActions } from './inbox.js'

export {
  type ProcessParticipantOptions,
  processParticipantPolicy,
  withProcessParticipants,
} from './policy.js'
export {
  type ProcessDecisionInfo,
  type ProcessInstanceInfo,
  type ProcessObjectData,
  type ProcessObjectProvider,
  type ProcessStepHandler,
  type ProcessStepInfo,
  registerProcessObjectProvider,
  registerProcessStepHandler,
  registerProcessWaitEvent,
  type StepHandlerInput,
  type StepHandlerResult,
} from './registry.js'
export { type ActInput, ProcessService, type StartProcessInput } from './service.js'

/** Действия шагов во Входящих — при старте в любой роли процесса (HTTP исполняет кнопки). */
export function registerProcessEngine(): void {
  registerProcessInboxActions()
}
