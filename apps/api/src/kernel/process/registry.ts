import type { Step } from '@kchs/process'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'

/**
 * Расширения движка процессов для модулей (ADR-0079). Ядро не знает о
 * документах и поручениях: модуль при старте регистрирует поставщика данных
 * своего типа объекта (автор, поля для `field:` и условий, хуки шагов) и
 * исполнителей шагов, которые выполняет сам (`register`, `task`, `call`).
 */

/** Данные объекта для выражений назначений и условий. */
export interface ProcessObjectData {
  /** `author`, `author.unit`. */
  authorId: string | null
  /** Подразделение автора, если объект задаёт его сам (иначе — основное подразделение автора). */
  authorUnitId?: string | null
  /** Пространство: `role:` и `role_in_space:`. */
  spaceId: string | null
  title: string
  /** Поля карточки: `field:<путь>`, `object.fields.<ключ>`. */
  fields: Record<string, unknown>
  /** Сводные свойства для условий: `object.<имя>` (например, `object.typeKey`). */
  props?: Record<string, unknown>
}

/** Экземпляр маршрута для хуков и исполнителей. */
export interface ProcessInstanceInfo {
  id: string
  definitionId: string
  definitionKey: string
  version: number
  objectId: string
  objectType: string
  initiatorId: string | null
  variables: Record<string, unknown>
  round: number
}

/** Активация шага для хуков и исполнителей. */
export interface ProcessStepInfo {
  id: string
  key: string
  type: Step['type']
  /** Определение шага (с параметрами: `journal`, `title`, `params`…). */
  definition: Step
  round: number
  /** Назначенные (исполнители `task`, получатели `notify`). */
  assignees: string[]
  dueAt: string | null
  outcome: string | null
  result: Record<string, unknown> | null
}

export interface ProcessDecisionInfo {
  /** Чья очередь (при замещении — замещаемый). */
  userId: string
  /** Кто нажал кнопку. */
  actorId: string
  onBehalfOf: string | null
  action: string
  comment: string | null
  fileIds: string[]
}

export interface ProcessObjectProvider {
  objectType: string
  /** Данные объекта; `null` — объекта нет. */
  load: (executor: Executor, objectId: string) => Promise<ProcessObjectData | null>
  /** Шаг `set`: изменить поле объекта. */
  setField?: (
    tx: Executor,
    ctx: Ctx,
    objectId: string,
    field: string,
    value: unknown,
  ) => Promise<void>
  /**
   * Запуск через общий API `POST /processes`: бросает ошибку, если нельзя.
   * Без функции маршрут объекта запускает только модуль.
   */
  canStart?: (
    ctx: UserCtx,
    objectId: string,
    definition: { key: string; version: number },
  ) => Promise<void>
  onStepActivated?: (
    tx: Executor,
    ctx: Ctx,
    event: { instance: ProcessInstanceInfo; step: ProcessStepInfo },
  ) => Promise<void>
  /** Каждое решение назначенного (лист согласования, подпись версии). */
  onDecision?: (
    tx: Executor,
    ctx: Ctx,
    event: { instance: ProcessInstanceInfo; step: ProcessStepInfo; decision: ProcessDecisionInfo },
  ) => Promise<void>
  onStepCompleted?: (
    tx: Executor,
    ctx: Ctx,
    event: { instance: ProcessInstanceInfo; step: ProcessStepInfo },
  ) => Promise<void>
  onFinished?: (
    tx: Executor,
    ctx: Ctx,
    event: { instance: ProcessInstanceInfo; status: 'finished' | 'cancelled'; outcome: string },
  ) => Promise<void>
}

export interface StepHandlerInput {
  instance: ProcessInstanceInfo
  step: ProcessStepInfo
  /** Параметры шага `call`/`task`. */
  params: Record<string, unknown>
  /** Кто выполняет шаг-решение (`register` из Входящих); автоматический шаг — `null`. */
  actor: { userId: string; onBehalfOf: string | null } | null
  /** Данные действия пользователя (номер вручную, файлы). */
  payload: Record<string, unknown>
}

/** Итог шага модуля; `wait` — модуль завершит шаг позже (`ProcessService.completeStep`). */
export type StepHandlerResult = { outcome?: string; result?: Record<string, unknown> } | 'wait'

export interface ProcessStepHandler {
  type: 'register' | 'task' | 'call'
  /** Только для этого типа объекта; без него — для всех. */
  objectType?: string
  /** Для `call`: действие `documents.dispatch`. */
  action?: string
  execute: (tx: Executor, ctx: Ctx, input: StepHandlerInput) => Promise<StepHandlerResult>
  /** Шаг отменён (маршрут отменён, ветвь снята): модуль снимает свои поручения. */
  cancel?: (tx: Executor, ctx: Ctx, input: StepHandlerInput) => Promise<void>
}

const providers = new Map<string, ProcessObjectProvider>()
const handlers: ProcessStepHandler[] = []
/** События, которых может ждать шаг `wait` (о своём объекте). */
const waitable = new Set<string>(['object.updated', 'object.linked', 'process.finished'])

export function registerProcessObjectProvider(provider: ProcessObjectProvider): void {
  if (providers.has(provider.objectType)) {
    throw new Error(`Поставщик данных маршрутов для «${provider.objectType}» уже зарегистрирован`)
  }
  providers.set(provider.objectType, provider)
}

export function processObjectProvider(objectType: string): ProcessObjectProvider | undefined {
  return providers.get(objectType)
}

export function registerProcessStepHandler(handler: ProcessStepHandler): void {
  if (handler.type === 'call' && !handler.action) {
    throw new Error('Исполнитель шага call регистрируется с действием (action)')
  }
  const duplicate = handlers.some(
    (item) =>
      item.type === handler.type &&
      (item.objectType ?? null) === (handler.objectType ?? null) &&
      (item.action ?? null) === (handler.action ?? null),
  )
  if (duplicate) {
    throw new Error(
      `Исполнитель шага ${handler.type}${handler.action ? ` ${handler.action}` : ''} уже зарегистрирован`,
    )
  }
  handlers.push(handler)
}

/** Исполнитель шага: сначала для типа объекта, затем общий. */
export function processStepHandler(
  type: ProcessStepHandler['type'],
  objectType: string,
  action?: string,
): ProcessStepHandler | undefined {
  const matches = handlers.filter(
    (item) => item.type === type && (type !== 'call' || item.action === action),
  )
  return (
    matches.find((item) => item.objectType === objectType) ??
    matches.find((item) => !item.objectType)
  )
}

/**
 * Модуль разрешает шагам `wait` ждать своё событие (тип — из каталога событий).
 * @public — документы второй волны: `document.version_added`, `document.signed`.
 */
export function registerProcessWaitEvent(type: string): void {
  waitable.add(type)
}

export function waitableEvents(): string[] {
  return [...waitable]
}
