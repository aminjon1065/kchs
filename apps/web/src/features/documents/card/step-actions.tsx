import type { DocumentRecord } from '@kchs/contracts'
import { Button } from '@kchs/ui'
import { useQueryClient } from '@tanstack/react-query'
import { Ban, Stamp } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { documentKeys } from '../queries.js'
import { useDocument } from './document-context.js'
import { CancelDialog, RegisterDialog } from './document-dialogs.js'

/**
 * Слот «Действия шага» в контекст-панели карточки (03-screens.md §12). Вторая
 * волна добавляет сюда действия текущего шага маршрута — Согласовать /
 * Замечания / Отклонить / Подписать — и «Наложить резолюцию»; сейчас —
 * доменные действия документа, доступные пользователю: регистрация и
 * аннулирование. Права считает сервер (`document.can`).
 */
export function DocumentStepActions() {
  const t = useT()
  const client = useQueryClient()
  const { document, refresh } = useDocument()
  const [dialog, setDialog] = useState<'register' | 'cancel' | null>(null)

  const done = (record: DocumentRecord) => {
    client.setQueryData(documentKeys.document(record.id), record)
    setDialog(null)
    refresh()
  }

  if (!document.can.register && !document.can.cancel) return null
  return (
    <section
      aria-label={t('documents.actions.title')}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.actions.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {document.can.register ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Stamp className="size-3.5" />}
            onClick={() => setDialog('register')}
          >
            {t('documents.actions.register')}
          </Button>
        ) : null}
        {document.can.cancel ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Ban className="size-3.5" />}
            onClick={() => setDialog('cancel')}
          >
            {t('documents.actions.cancel')}
          </Button>
        ) : null}
      </div>
      {dialog === 'register' ? (
        <RegisterDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </section>
  )
}
