import { lazy } from 'react'
import type { ModuleDefinition } from '~/shared/workspace/registry.js'

/** Помощник — отдельным чанком: вкладку открывают не каждый раз, а с ним идут диалоги задач. */
const AssistantPanel = lazy(() =>
  import('./assistant-panel.js').then((module) => ({ default: module.AssistantPanel })),
)

/** Что модуль «Ассистент» даёт оболочке (ADR-0183): вкладку контекст-панели. */
export const assistantModule: ModuleDefinition = {
  key: 'assistant',
  slots: [
    {
      key: 'assistant-panel',
      placement: 'context-assistant',
      render: (objectId) => <AssistantPanel objectId={objectId} />,
    },
  ],
}
