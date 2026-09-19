import { EmptyState } from '@kchs/ui'
import { Route } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useDocument } from './document-context.js'

/**
 * Слот вкладки «Маршрут» (03-screens.md §12; вторая волна P3-E02 S04 и движок
 * процессов P3-E01): горизонтальная линия шагов с аватарами, статусами и
 * сроками, текущий шаг раскрыт. Документ — из `useDocument()`; маршрут по
 * умолчанию задаёт тип документа (`defaultRouteKey`). Пока маршрут не запущен —
 * пустое состояние.
 */
export function RouteTab() {
  const t = useT()
  const { document } = useDocument()
  return (
    <EmptyState
      icon={<Route />}
      title={t('documents.route.empty')}
      description={t(
        document.status === 'draft' ? 'documents.route.emptyDraft' : 'documents.route.emptyHint',
      )}
    />
  )
}
