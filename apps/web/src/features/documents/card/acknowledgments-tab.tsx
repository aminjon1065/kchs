import { EmptyState } from '@kchs/ui'
import { BookCheck } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useDocument } from './document-context.js'

/**
 * Слот вкладки «Ознакомление» (08-documents.md §10; вторая волна): список лиц
 * и подразделений, отметки, «кто не ознакомился». Правило типа
 * `document.type.settings.ackOnRegister` назначает ознакомление при регистрации.
 */
export function AcknowledgmentsTab() {
  const t = useT()
  const { document } = useDocument()
  return (
    <EmptyState
      icon={<BookCheck />}
      title={t('documents.acknowledgments.empty')}
      description={t(
        document.type.settings.ackOnRegister
          ? 'documents.acknowledgments.onRegister'
          : 'documents.acknowledgments.emptyHint',
      )}
    />
  )
}
