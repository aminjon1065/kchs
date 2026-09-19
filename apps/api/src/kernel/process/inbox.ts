import { DECISIONS, type Decision } from '@kchs/process'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { registerInboxActionHandler } from '../inbox/actions.js'
import { ProcessService } from './service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Кнопки шагов маршрута во Входящих, в Telegram и через API — одним путём
 * (ADR-0060, ADR-0079): элемент знает свой шаг, действие выполняет
 * `ProcessService.act`. Копия заместителя действует от имени получателя;
 * код второго фактора и файлы замечаний — в `payload` действия. Дела
 * `acknowledge` исполняет механизм ознакомления ядра (ADR-0084): шаг маршрута
 * и запрос из карточки — один учёт.
 */
export function registerProcessInboxActions(): void {
  for (const kind of ['approve', 'sign', 'register', 'revise'] as const) {
    registerInboxActionHandler(kind, async (ctx, { item, action, comment, payload }) => {
      const stepId = item.processStepId
      if (!stepId) throw errors.validation('Это действие выполняется в карточке объекта')
      if (!DECISIONS.includes(action as Decision)) {
        throw errors.validation('Нет такого действия у шага маршрута')
      }
      const actor: UserCtx = { ...ctx, onBehalfOf: item.onBehalfOf }
      const fileIds = Array.isArray(payload?.fileIds)
        ? payload.fileIds.filter((id): id is string => typeof id === 'string' && UUID.test(id))
        : []
      const code = typeof payload?.code === 'string' ? payload.code : undefined
      await db().transaction((tx) =>
        ProcessService.act(tx, actor, {
          stepId,
          action: action as Decision,
          comment: comment ?? null,
          fileIds,
          code,
        }),
      )
    })
  }
}
