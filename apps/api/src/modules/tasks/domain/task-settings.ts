import { TaskEscalationSettings, type TaskSettings } from '@kchs/contracts'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { SettingsService } from '~/kernel/settings/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { DEFAULT_ESCALATION } from './task-deadlines.js'

/** Ключ системной настройки эскалации просроченных поручений. */
const ESCALATION_KEY = 'tasks.escalation'

/**
 * Настройки поручений установки (10-tasks-projects.md §4, ADR-0082): эскалация
 * просрочки руководителю исполнителя — включена ли и через сколько рабочих
 * дней после срока. Испорченное значение заменяется умолчанием.
 */
export const TaskSettingsService = {
  async current(): Promise<TaskSettings> {
    const raw = await SettingsService.get<unknown>(
      ESCALATION_KEY,
      [{ scope: 'system' }],
      DEFAULT_ESCALATION,
    )
    const parsed = TaskEscalationSettings.safeParse(raw)
    return { escalation: parsed.success ? parsed.data : DEFAULT_ESCALATION }
  },

  async update(tx: Executor, ctx: Ctx, next: TaskSettings): Promise<TaskSettings> {
    const before = await TaskSettingsService.current()
    await SettingsService.set(tx, ctx, 'system', null, ESCALATION_KEY, next.escalation)
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.settingsChanged,
        details: { key: ESCALATION_KEY, before: before.escalation, after: next.escalation },
        severity: 'notice',
      },
      tx,
    )
    return next
  },
}
