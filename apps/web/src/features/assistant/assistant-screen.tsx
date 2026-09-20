import { PanelToolbar } from '@kchs/ui'
import { useT } from '~/app/i18n.js'
import { AssistantPanel } from './assistant-panel.js'

/**
 * Экран ассистента (13-search-knowledge-ai.md §5, ADR-0100): разговор без
 * привязки к объекту — ассистент ищет по всей платформе правами спрашивающего.
 * Диалог тот же, что в контекстной панели, только шире и с собственной вкладкой.
 */
export function AssistantScreen() {
  const t = useT()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('shell.rail.assistant')}</h1>}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <AssistantPanel objectId={null} />
      </div>
    </div>
  )
}
