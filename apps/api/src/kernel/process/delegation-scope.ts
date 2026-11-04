import type { InboxKind } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'
import { delegationCovers } from '../inbox/actions.js'

/** Вид дела «Входящих» у шага решения процесса. */
export const INBOX_KIND: Record<string, InboxKind> = {
  approval: 'approve',
  sign: 'sign',
  acknowledge: 'acknowledge',
  register: 'register',
  return: 'revise',
}

/**
 * Замещение с областью `scope` распространяется на шаг вида `stepType` (ADR-0229): по
 * виду дела шага; у шагов без дела «Входящих» — только замещение «все дела».
 */
export function delegationCoversStep(stepType: string, scope: string): boolean {
  const kind = INBOX_KIND[stepType]
  return kind ? delegationCovers(kind, scope) : scope === 'all'
}

/** Виды шагов, на которые распространяется замещение `scope`. */
export function stepTypesCovered(scope: string, stepTypes: readonly string[]): string[] {
  return stepTypes.filter((type) => delegationCoversStep(type, scope))
}

/** Отсутствующие, за которых пользователь действует на шаге вида `stepType`. */
export function actingForStep(ctx: UserCtx, stepType: string): string[] {
  return ctx.principals.actingFor
    .filter((item) => delegationCoversStep(stepType, item.scope))
    .map((item) => item.userId)
}
