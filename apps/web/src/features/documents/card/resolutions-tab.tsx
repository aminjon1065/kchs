import { EmptyState } from '@kchs/ui'
import { GitBranch } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useDocument } from './document-context.js'

/**
 * Слот вкладки «Резолюции и поручения» (03-screens.md §12; вторая волна
 * P3-E02 S05): дерево резолюций и созданных ими поручений со статусами.
 * Резолюции разрешает правило типа `document.type.settings.allowResolutions`.
 */
export function ResolutionsTab() {
  const t = useT()
  const { document } = useDocument()
  return (
    <EmptyState
      icon={<GitBranch />}
      title={t('documents.resolutions.empty')}
      description={t(
        document.type.settings.allowResolutions
          ? 'documents.resolutions.emptyHint'
          : 'documents.resolutions.notAllowed',
      )}
    />
  )
}
