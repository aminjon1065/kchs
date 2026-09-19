import type { DocumentSignature, LangText } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Route, Send, ShieldCheck, Undo2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { outcomeTone } from '~/features/processes/labels.js'
import { objectProcessesQuery, processApi, processQuery } from '~/features/processes/queries.js'
import { RouteLine } from '~/features/processes/route-line.js'
import { ProcessStepActions } from '~/features/processes/step-actions.js'
import { ApiError } from '~/shared/api/client.js'
import { documentRouteVersionsQuery, documentSignaturesQuery } from '../queries.js'
import { useDocument } from './document-context.js'
import { RouteStartDialog } from './route-start-dialog.js'

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

const SIGNATURE_TONE = { valid: 'success', pending: 'neutral', mismatch: 'danger' } as const

/** Подписи документа и их проверка по хэшу подписанной версии (08-documents.md §9). */
function Signatures({ items }: { items: DocumentSignature[] }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <section className="flex flex-col gap-2" aria-label={t('documents.signatures.title')}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.signatures.title')}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((signature) => (
          <li
            key={signature.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2"
          >
            <ShieldCheck className="size-4 shrink-0 text-fg-muted" aria-hidden />
            <Avatar
              name={signature.signer.displayName}
              src={signature.signer.avatarUrl}
              size="sm"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">
                {signature.actor
                  ? t('documents.signatures.onBehalf', {
                      actor: signature.actor.displayName,
                      name: signature.signer.displayName,
                    })
                  : signature.signer.displayName}
              </span>
              <span className="block truncate text-2xs text-fg-muted">
                {[
                  formatDateTime(signature.signedAt, { locale }),
                  signature.versionNumber !== null
                    ? t('documents.signatures.version', { number: signature.versionNumber })
                    : null,
                  signature.current ? null : t('documents.signatures.notCurrent'),
                  signature.mfa ? t('documents.signatures.mfa') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {signature.hash ? (
              <Tooltip content={signature.hash}>
                <span className="font-mono text-2xs text-fg-muted">
                  {t('documents.signatures.hash', { hash: signature.hash.slice(0, 12) })}
                </span>
              </Tooltip>
            ) : null}
            <Badge tone={SIGNATURE_TONE[signature.state]} size="sm">
              {t(`documents.signatures.state.${signature.state}`)}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Отзыв с маршрута: маршрут останавливается, документ возвращается автору. */
function CancelRoute({ instanceId, onDone }: { instanceId: string; onDone: () => void }) {
  const t = useT()
  const toast = useToast()
  const reasonId = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const cancel = useMutation({
    mutationFn: () => processApi.cancel(instanceId, reason.trim() || undefined),
    onSuccess: () => {
      toast.show({ title: t('documents.route.cancelled'), tone: 'success' })
      setOpen(false)
      setReason('')
      onDone()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Undo2 className="size-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('documents.route.cancel')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={t('documents.route.cancel')}
          description={t('documents.route.cancelHint')}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                {t('documents.route.cancel')}
              </Button>
            </>
          }
        >
          <Field label={t('documents.route.cancelReason')} htmlFor={reasonId}>
            <Textarea
              id={reasonId}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Вкладка «Маршрут» (03-screens.md §12, 08-documents.md §15, ADR-0083): маршруты
 * документа (идущий — первым), линия шагов с назначенными, решениями, сроками и
 * версиями, решения смотрящего, отзыв с маршрута и подписи. Пока маршрута нет —
 * отправка по маршруту типа.
 */
export function RouteTab() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { document, refresh } = useDocument()
  const [selected, setSelected] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const instances = useQuery(objectProcessesQuery(document.id))
  const current = selected ?? instances.data?.[0]?.id ?? null
  const view = useQuery({
    ...processQuery(document.id, current ?? ''),
    enabled: Boolean(current),
  })
  const versions = useQuery(documentRouteVersionsQuery(document.id))
  const signatures = useQuery(documentSignaturesQuery(document.id))

  const startButton = document.can.startRoute ? (
    <Button
      variant="primary"
      size="sm"
      icon={<Send className="size-3.5" />}
      onClick={() => setStarting(true)}
    >
      {t('documents.route.start')}
    </Button>
  ) : null
  const dialog = starting ? <RouteStartDialog onClose={() => setStarting(false)} /> : null

  if (instances.isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (!instances.data?.length) {
    return (
      <>
        <EmptyState
          icon={<Route />}
          title={t('documents.route.empty')}
          description={t(
            document.can.startRoute ? 'documents.route.emptyStart' : 'documents.route.emptyHint',
          )}
          action={startButton}
        />
        {dialog}
      </>
    )
  }

  const data = view.data
  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {instances.data.length > 1 ? (
          <Select value={current ?? ''} onValueChange={setSelected}>
            <SelectTrigger className="w-auto min-w-64" aria-label={t('documents.route.history')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {instances.data.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {`${text(item.name, locale) ?? item.definitionKey} · ${formatDateTime(item.startedAt, { locale })}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium text-fg">
            {data ? (text(data.name, locale) ?? data.definitionKey) : null}
          </span>
        )}
        {data ? (
          <Badge
            tone={data.status === 'running' ? 'accent' : outcomeTone(data.outcome)}
            size="sm"
            dot
          >
            {t(`processes.status.${data.status}`)}
          </Badge>
        ) : null}
        <span className="flex-1" />
        {data?.status === 'running' && data.canCancel ? (
          <CancelRoute instanceId={data.id} onDone={refresh} />
        ) : null}
        {startButton}
      </div>
      {data ? (
        <>
          <p className="text-xs text-fg-muted">
            {t('documents.route.startedBy', {
              name: data.startedBy?.displayName ?? '—',
              date: formatDateTime(data.startedAt, { locale }),
            })}
          </p>
          {data.myActions.length > 0 ? (
            <section className="rounded-md border border-accent bg-surface p-3">
              <ProcessStepActions objectId={document.id} view={data} onDone={refresh} />
            </section>
          ) : null}
          <RouteLine view={data} versions={versions.data} />
        </>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
      {signatures.data?.length ? <Signatures items={signatures.data} /> : null}
      {dialog}
    </div>
  )
}

/**
 * Идущий маршрут в шапке карточки: текущий шаг, кто ждёт и срок; просрочка —
 * красным. Щелчок ведёт на вкладку «Маршрут».
 */
export function DocumentRouteIndicator() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { document, openSection } = useDocument()
  const step = document.route?.steps[0]
  if (!document.route || !step) return null
  const name = text(step.name, locale) ?? text(document.route.name, locale) ?? ''
  const names = step.pending.map((user) => user.displayName).join(', ')
  const label = names ? t('documents.header.routeStep', { step: name, names }) : name
  // Шаг с длинным названием и списком ждущих не вытесняет заголовок документа:
  // подпись обрезается, целиком — в подсказке
  return (
    <Tooltip
      content={
        step.dueAt
          ? `${label} · ${t('documents.route.dueShort', { date: formatDateTime(step.dueAt, { locale }) })}`
          : label
      }
    >
      <Button
        variant="ghost"
        size="sm"
        icon={<Route className="size-3.5 shrink-0" />}
        onClick={() => openSection('route')}
        className={step.overdue ? 'min-w-0 max-w-72 text-danger' : 'min-w-0 max-w-72'}
      >
        <span className="truncate">{label}</span>
      </Button>
    </Tooltip>
  )
}
