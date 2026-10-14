import type { QesSessionRecord } from '@kchs/contracts'
import type { ProcessMyAction } from '@kchs/process'
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  SegmentedControl,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RotateCcw } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { keys, meQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { documentKeys, qualifiedSession, startQualifiedSigning } from '../queries.js'
import { useDocument } from './document-context.js'

const OPEN_STATES = new Set<QesSessionRecord['state']>([
  'awaiting_certificate',
  'preparing',
  'awaiting_signature',
  'verifying',
])

const STATE_TONE: Record<QesSessionRecord['state'], 'neutral' | 'success' | 'danger'> = {
  awaiting_certificate: 'neutral',
  preparing: 'neutral',
  awaiting_signature: 'neutral',
  verifying: 'neutral',
  signed: 'success',
  failed: 'danger',
}

/**
 * Подписание квалифицированной подписью (ADR-0205): сеанс на шаг, ссылка на
 * страницу подписания (агент УЦ на рабочем месте или ключ УЦ Комитета на устройстве,
 * ADR-0218), ожидание результата. Карточка сама узнаёт, что подпись встала, и
 * обновляется. Кто держит печать организации, выбирает, чем подписать: своей подписью
 * или печатью.
 */
function QualifiedSignDialog({ item, onClose }: { item: ProcessMyAction; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { document, refresh } = useDocument()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [seal, setSeal] = useState(false)
  const started = useRef(false)
  const { data: me } = useQuery(meQuery())
  const canSeal = me?.capabilities.includes('documents.seal') ?? false

  const start = useMutation({
    mutationFn: (asSeal: boolean) =>
      startQualifiedSigning(document.id, {
        stepId: item.stepId,
        onBehalfOf: item.onBehalfOf?.id ?? null,
        ...(asSeal ? { seal: true } : {}),
      }),
    onSuccess: (session) => setSessionId(session.id),
  })
  const startSession = start.mutate

  // Сеанс начинается, как только открыт диалог: ссылка на страницу нужна сразу
  useEffect(() => {
    if (started.current) return
    started.current = true
    startSession(false)
  }, [startSession])

  const session = useQuery({
    queryKey: [...documentKeys.signatures(document.id), 'qes', sessionId],
    queryFn: () => qualifiedSession(document.id, sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: (query) =>
      OPEN_STATES.has(query.state.data?.state ?? 'awaiting_certificate') ? 2000 : false,
  })
  const record = session.data ?? start.data ?? null

  useEffect(() => {
    if (record?.state !== 'signed') return
    toast.show({ title: t('documents.qualified.dialog.signed'), tone: 'success' })
    void client.invalidateQueries({ queryKey: documentKeys.signatures(document.id) })
    void client.invalidateQueries({ queryKey: keys.object(document.id) })
    void client.invalidateQueries({ queryKey: ['inbox'] })
    refresh()
    onClose()
  }, [record?.state, client, document.id, onClose, refresh, t, toast])

  // Новый сеанс заменяет прежний (сервер закрывает его как «начато новое подписание»)
  const restart = (asSeal = seal) => {
    setSeal(asSeal)
    setSessionId(null)
    start.reset()
    startSession(asSeal)
  }
  const failure = start.error
    ? start.error.message || t('errors.unknown')
    : record?.state === 'failed'
      ? record.reason
        ? t(`documents.qualified.reasons.${record.reason}`)
        : (record.error ?? '')
      : null

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('documents.qualified.dialog.title')}
        description={t('documents.qualified.dialog.hint')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.close')}
            </Button>
            {failure !== null ? (
              <Button
                variant="secondary"
                icon={<RotateCcw className="size-3.5" />}
                loading={start.isPending}
                onClick={() => restart()}
              >
                {t('documents.qualified.dialog.restart')}
              </Button>
            ) : null}
            {record?.signingUrl ? (
              <Button
                variant="primary"
                icon={<ExternalLink className="size-3.5" />}
                onClick={() => window.open(record.signingUrl ?? '', '_blank', 'noopener')}
              >
                {t('documents.qualified.dialog.open')}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {canSeal ? (
            <SegmentedControl<'person' | 'seal'>
              value={seal ? 'seal' : 'person'}
              onValueChange={(next) => restart(next === 'seal')}
              aria-label={t('documents.qualified.dialog.signAs')}
              className="self-start"
              options={[
                { value: 'person', label: t('documents.qualified.dialog.asPerson') },
                { value: 'seal', label: t('documents.qualified.dialog.asSeal') },
              ]}
            />
          ) : null}
          {record ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATE_TONE[record.state]} size="sm">
                {t(`documents.qualified.states.${record.state}`)}
              </Badge>
              {record.certificate ? (
                <span className="text-sm text-fg-muted">
                  {t('documents.qualified.dialog.certificate', {
                    owner: record.certificate.owner,
                    serial: record.certificate.serial.toUpperCase(),
                  })}
                </span>
              ) : null}
            </div>
          ) : start.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-48" />
              <p className="text-sm text-fg-muted">{t('documents.qualified.dialog.starting')}</p>
            </div>
          ) : null}
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Кнопка «Подписать КЭП» шага маршрута открывает диалог подписания. */
export function useQualifiedSign(): {
  start: (item: ProcessMyAction) => void
  dialog: ReactNode
} {
  const [item, setItem] = useState<ProcessMyAction | null>(null)
  const close = useCallback(() => setItem(null), [])
  return {
    start: setItem,
    dialog: item ? <QualifiedSignDialog key={item.stepId} item={item} onClose={close} /> : null,
  }
}
