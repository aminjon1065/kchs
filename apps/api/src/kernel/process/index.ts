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
import type { ProcessDefinition, ProcessPreview, ProcessPreviewInput } from '@kchs/process'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { registerProcessConfigSection } from './config-section.js'
import { DefinitionService } from './definitions.js'
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
  type ProcessObserver,
  type ProcessStepChange,
  type ProcessStepHandler,
  type ProcessStepInfo,
  registerProcessObjectProvider,
  registerProcessObserver,
  registerProcessStepHandler,
  registerProcessWaitEvent,
  type StepHandlerInput,
  type StepHandlerResult,
} from './registry.js'
export { type ActInput, ProcessService, type StartProcessInput } from './service.js'
export { type ActiveRoute, ProcessView } from './view.js'

/**
 * Определения маршрутов для модулей (ADR-0083): опубликованные маршруты типа —
 * для запуска из карточки, предпросмотр назначений на объекте без способности
 * `processes.manage` (права проверяет модуль), стартовые маршруты сида.
 */
export const ProcessDefinitions = {
  published: (
    executor: Executor,
    objectType: string,
  ): Promise<Array<{ id: string; key: string; version: number; definition: ProcessDefinition }>> =>
    DefinitionService.publishedFor(executor, objectType),
  preview: (ctx: UserCtx, input: ProcessPreviewInput): Promise<ProcessPreview> =>
    DefinitionService.preview(ctx, input),
  ensure: (tx: Executor, ctx: Ctx, definition: unknown): Promise<boolean> =>
    DefinitionService.ensurePublished(tx, ctx, definition),
}

/** Действия шагов во Входящих — при старте в любой роли процесса (HTTP исполняет кнопки). */
export function registerProcessEngine(): void {
  registerProcessInboxActions()
  // Маршруты переносятся между контурами пакетом конфигурации (ADR-0097)
  registerProcessConfigSection()
}
