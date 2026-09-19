import type { DocumentRecord } from '@kchs/contracts'
import { Button } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Send, Stamp } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { processQuery } from '~/features/processes/queries.js'
import { ProcessStepActions } from '~/features/processes/step-actions.js'
import { meQuery } from '~/shared/api/queries.js'
import { documentKeys } from '../queries.js'
import { useDocument } from './document-context.js'
import { CancelDialog, RegisterDialog } from './document-dialogs.js'
import { RouteStartDialog } from './route-start-dialog.js'

/** Ждёт ли решения смотрящего (или того, кого он замещает) текущий шаг маршрута. */
export function useAwaitsMe(document: DocumentRecord): boolean {
  const { data: me } = useQuery(meQuery())
  if (!me || !document.route) return false
  const people = new Set([me.user.id, ...me.actingFor.map((item) => item.fromUser.id)])
  return document.route.steps.some((step) => step.pending.some((user) => people.has(user.id)))
}

/**
 * Слот «Действия шага» в контекст-панели карточки (03-screens.md §12, ADR-0083):
 * решения текущего шага маршрута — Согласовать / Замечания / Отклонить /
 * Подписать с кодом, передача и новый согласующий; «Отправить на
 * согласование»; доменные действия — регистрация и аннулирование. Права
 * считает сервер (`document.can`, действия шага — движок процессов).
 */
export function DocumentStepActions() {
  const t = useT()
  const client = useQueryClient()
  const { document, refresh } = useDocument()
  const [dialog, setDialog] = useState<'register' | 'cancel' | 'route' | null>(null)
  const instanceId = document.route?.instanceId ?? null
  const awaitsMe = useAwaitsMe(document)
  const route = useQuery({
    ...processQuery(document.id, instanceId ?? ''),
    enabled: Boolean(instanceId) && awaitsMe,
  })

  const done = (record: DocumentRecord) => {
    client.setQueryData(documentKeys.document(record.id), record)
    setDialog(null)
    refresh()
  }

  const routeActions = route.data && route.data.myActions.length > 0 ? route.data : null
  if (!document.can.register && !document.can.cancel && !document.can.startRoute && !routeActions) {
    return null
  }
  return (
    <section
      aria-label={t('documents.actions.title')}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.actions.title')}
      </h2>
      {routeActions ? (
        <ProcessStepActions objectId={document.id} view={routeActions} onDone={refresh} />
      ) : null}
      {document.can.startRoute || document.can.register || document.can.cancel ? (
        <div className="flex flex-wrap gap-2">
          {document.can.startRoute ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Send className="size-3.5" />}
              onClick={() => setDialog('route')}
            >
              {t('documents.route.start')}
            </Button>
          ) : null}
          {document.can.register ? (
            <Button
              variant={document.can.startRoute ? 'secondary' : 'primary'}
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
      ) : null}
      {dialog === 'route' ? <RouteStartDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'register' ? (
        <RegisterDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </section>
  )
}
