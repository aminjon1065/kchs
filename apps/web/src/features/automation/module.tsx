import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { ManualRuleActions } from './manual-rules.js'

/** Что модуль автоматизации даёт оболочке (ADR-0183): правила с ручным запуском объекта. */
export const automationModule: ModuleDefinition = {
  key: 'automation',
  namespaces: ['automation'],
  slots: [
    {
      key: 'manual-rules',
      placement: 'context-info',
      // Правила с ручным запуском для этого объекта (ADR-0096)
      render: (objectId) => <ManualRuleActions objectId={objectId} />,
    },
  ],
}
