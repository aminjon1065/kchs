import type { NamedWorkspace, NamedWorkspaceSummary } from '@kchs/contracts'
import { useToast } from '@kchs/ui'
import { http } from '~/shared/api/client.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from './store.js'

/** Открыть сохранённое рабочее пространство с возможностью вернуть прежние вкладки. */
export function useOpenWorkspace() {
  const t = useT()
  const toast = useToast()
  const applyLayout = useWorkspace((s) => s.applyLayout)
  const restore = useWorkspace((s) => s.restore)
  const takeSnapshot = useWorkspace((s) => s.snapshot)

  return async (summary: Pick<NamedWorkspaceSummary, 'id' | 'title'>) => {
    try {
      const workspace = await http.get<NamedWorkspace>(`/workspaces/${summary.id}`)
      const previous = takeSnapshot()
      applyLayout(workspace.layout)
      toast.show({
        title: t('shell.workspaces.opened', { title: workspace.title }),
        tone: 'info',
        action: { label: t('shell.workspaces.undo'), onClick: () => restore(previous) },
      })
    } catch {
      toast.error(t('errors.unknown'))
    }
  }
}
