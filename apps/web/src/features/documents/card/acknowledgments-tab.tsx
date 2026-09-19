import type {
  AcknowledgmentEntry,
  AcknowledgmentRequestResult,
  ObjectAcknowledgments,
  PrincipalRef,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SegmentedControl,
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, BookCheck, Check, Send } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { PrincipalsPicker } from '../principals-picker.js'
import { acknowledgmentsQuery, documentKeys } from '../queries.js'
import { errorText, localToday } from '../status.js'
import { useDocument } from './document-context.js'

type Filter = 'all' | 'pending' | 'acknowledged'

const STATE_TONE: Record<AcknowledgmentEntry['state'], 'success' | 'accent' | 'neutral'> = {
  acknowledged: 'success',
  pending: 'accent',
  cancelled: 'neutral',
}

/**
 * Вкладка «Ознакомление» (08-documents.md §10, ADR-0084): кто ознакомился и
 * когда, кто ещё нет (просроченные — первыми), запросы — вручную, при
 * регистрации и шагом маршрута; «Ознакомлен» (с кодом второго фактора, если
 * запрос его требует), «Отправить на ознакомление», «Напомнить».
 */
export function AcknowledgmentsTab() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { document } = useDocument()
  const { data, isLoading, error, refetch } = useQuery(acknowledgmentsQuery(document.id))
  const [filter, setFilter] = useState<Filter>('all')
  const [dialog, setDialog] = useState<'send' | 'code' | null>(null)

  const acknowledge = useMutation({
    mutationFn: (code?: string) =>
      http.post<ObjectAcknowledgments>(
        `/objects/${document.id}/acknowledgments/acknowledge`,
        code ? { code } : {},
      ),
    onSuccess: (next) => {
      client.setQueryData(documentKeys.acknowledgments(document.id), next)
      void client.invalidateQueries({ queryKey: ['inbox'] })
      toast.show({ title: t('documents.acknowledgments.acknowledged'), tone: 'success' })
      setDialog(null)
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })
  const remind = useMutation({
    mutationFn: () =>
      http.post<{ reminded: number }>(`/objects/${document.id}/acknowledgments/remind`, {}),
    onSuccess: ({ reminded }) => {
      toast.show({
        title: t('documents.acknowledgments.reminded', { count: reminded }),
        tone: reminded > 0 ? 'success' : 'info',
      })
      void refetch()
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error || !data) {
    return <ErrorState description={errorText(error, t('errors.unknown'))} onRetry={refetch} />
  }

  const { summary, mine, can } = data
  const items = data.items.filter((item) => filter === 'all' || item.state === filter)
  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 p-4">
      {mine.pending ? (
        <Callout
          tone="info"
          title={t('documents.acknowledgments.mine')}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Check className="size-3.5" />}
              loading={acknowledge.isPending}
              onClick={() =>
                mine.requireSecondFactor ? setDialog('code') : acknowledge.mutate(undefined)
              }
            >
              {t('documents.acknowledgments.acknowledge')}
            </Button>
          }
        >
          {mine.requireSecondFactor ? t('documents.acknowledgments.mineCode') : null}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {summary.total > 0 ? (
          <span className="text-sm text-fg">
            {t('documents.acknowledgments.summary', {
              acknowledged: summary.acknowledged,
              total: summary.total,
            })}
          </span>
        ) : null}
        {summary.overdue > 0 ? (
          <Badge size="sm" tone="danger">
            {t('documents.acknowledgments.overdue', { count: summary.overdue })}
          </Badge>
        ) : null}
        <span className="flex-1" />
        {can.remind && summary.pending > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<BellRing className="size-3.5" />}
            loading={remind.isPending}
            onClick={() => remind.mutate()}
          >
            {t('documents.acknowledgments.remind')}
          </Button>
        ) : null}
        {can.request && document.status !== 'draft' && document.status !== 'cancelled' ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Send className="size-3.5" />}
            onClick={() => setDialog('send')}
          >
            {t('documents.acknowledgments.send')}
          </Button>
        ) : null}
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          icon={<BookCheck />}
          title={t('documents.acknowledgments.empty')}
          description={t(
            document.type.settings.ackOnRegister
              ? 'documents.acknowledgments.onRegister'
              : 'documents.acknowledgments.emptyHint',
          )}
        />
      ) : (
        <>
          <SegmentedControl
            size="sm"
            aria-label={t('documents.acknowledgments.filter')}
            value={filter}
            onValueChange={(next) => setFilter(next as Filter)}
            options={(['all', 'pending', 'acknowledged'] as const).map((value) => ({
              value,
              label: t(`documents.acknowledgments.filters.${value}`),
            }))}
          />
          <ul aria-label={t('documents.acknowledgments.list')} className="flex flex-col gap-1">
            {items.map((item) => (
              <EntryRow key={item.user.id} item={item} />
            ))}
          </ul>
          <Requests view={data} />
        </>
      )}

      {dialog === 'send' ? (
        <SendDialog
          documentId={document.id}
          requireCodeDefault={document.type.settings.ackRequireMfa}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'code' ? (
        <CodeDialog
          pending={acknowledge.isPending}
          failure={acknowledge.error}
          onSubmit={(code) => acknowledge.mutate(code)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}

function EntryRow({ item }: { item: AcknowledgmentEntry }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <li className="flex items-center gap-2 rounded-xs px-2 py-1.5 text-sm">
      <Avatar name={item.user.displayName} src={item.user.avatarUrl} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fg">{item.user.displayName}</span>
        {item.user.position || item.user.unitName ? (
          <span className="block truncate text-xs text-fg-muted">
            {[item.user.position, item.user.unitName].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </span>
      <span className="flex flex-col items-end gap-0.5 text-xs text-fg-secondary">
        {item.state === 'acknowledged' && item.acknowledgedAt ? (
          <span>
            {t('documents.acknowledgments.at', {
              date: formatDateTime(item.acknowledgedAt, { locale }),
            })}
            {item.actor
              ? ` · ${t('documents.acknowledgments.by', { name: item.actor.displayName })}`
              : ''}
            {item.secondFactor ? ` · ${t('documents.acknowledgments.withCode')}` : ''}
          </span>
        ) : null}
        {item.state === 'pending' && item.dueAt ? (
          <span className={cn(item.overdue && 'text-danger')}>
            {t('documents.acknowledgments.dueAt', { date: formatDate(item.dueAt, { locale }) })}
          </span>
        ) : null}
        {item.state === 'pending' && item.reminders > 0 ? (
          <span>{t('documents.acknowledgments.reminders', { count: item.reminders })}</span>
        ) : null}
      </span>
      <Badge size="sm" tone={item.overdue ? 'danger' : STATE_TONE[item.state]}>
        {t(`documents.acknowledgments.states.${item.state}`)}
      </Badge>
    </li>
  )
}

/** Запросы ознакомления: откуда, кем и когда, сколько отметок. */
function Requests({ view }: { view: ObjectAcknowledgments }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  if (view.requests.length === 0) return null
  return (
    <section
      aria-label={t('documents.acknowledgments.requests')}
      className="flex flex-col gap-1.5 border-t border-line pt-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.acknowledgments.requests')}
      </h2>
      <ul className="flex flex-col gap-1 text-xs text-fg-secondary">
        {view.requests.map((request) => (
          <li key={request.id} className={cn(request.cancelledAt && 'text-fg-muted line-through')}>
            {t('documents.acknowledgments.requestLine', {
              source: t(`documents.acknowledgments.sources.${request.source}`),
              name: request.requestedBy?.displayName ?? '—',
              date: formatDateTime(request.requestedAt, { locale }),
              done: request.acknowledged,
              total: request.total,
            })}
            {request.requireSecondFactor ? ` · ${t('documents.acknowledgments.withCode')}` : ''}
            {request.note ? ` · ${request.note}` : ''}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Отметка с кодом второго фактора. */
function CodeDialog({
  pending,
  failure,
  onSubmit,
  onClose,
}: {
  pending: boolean
  failure: unknown
  onSubmit: (code: string) => void
  onClose: () => void
}) {
  const t = useT()
  const codeId = useId()
  const [code, setCode] = useState('')
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.acknowledgments.acknowledge')}
        description={t('documents.acknowledgments.mineCode')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!code.trim()}
              loading={pending}
              onClick={() => onSubmit(code.trim())}
            >
              {t('documents.acknowledgments.acknowledge')}
            </Button>
          </>
        }
      >
        <Field
          label={t('inbox.code')}
          htmlFor={codeId}
          hint={t('inbox.codeHint')}
          error={failure instanceof ApiError ? failure.message : undefined}
          required
        >
          <Input
            id={codeId}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={24}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            mono
          />
        </Field>
      </DialogContent>
    </Dialog>
  )
}

/** «Отправить на ознакомление»: сотрудники, подразделения, группы; срок и код. */
function SendDialog({
  documentId,
  requireCodeDefault,
  onClose,
}: {
  documentId: string
  requireCodeDefault: boolean
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [recipients, setRecipients] = useState<PrincipalRef[]>([])
  const [dueDate, setDueDate] = useState('')
  const [requireCode, setRequireCode] = useState(requireCodeDefault)
  const [note, setNote] = useState('')
  const [result, setResult] = useState<AcknowledgmentRequestResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const ids = (type: string) =>
    recipients.filter((item) => item.type === type).map((item) => item.id)

  const send = useMutation({
    mutationFn: () =>
      http.post<AcknowledgmentRequestResult>(`/documents/${documentId}/acknowledgments`, {
        userIds: ids('user'),
        unitIds: ids('unit'),
        groupIds: ids('group'),
        dueDate: dueDate || null,
        requireSecondFactor: requireCode,
        note: note.trim() || null,
      }),
    onSuccess: (outcome) => {
      void client.invalidateQueries({ queryKey: documentKeys.acknowledgments(documentId) })
      if (outcome.skipped.length === 0) {
        toast.show({
          title: t('documents.acknowledgments.sent', { count: outcome.added }),
          tone: 'success',
        })
        onClose()
        return
      }
      // Кого пропустили — показываем в диалоге: без допуска к грифу, уже ждут
      setResult(outcome)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.acknowledgments.send')}
        size="md"
        footer={
          result ? (
            <Button variant="primary" onClick={onClose}>
              {t('common.actions.close')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={recipients.length === 0}
                loading={send.isPending}
                onClick={() => send.mutate()}
              >
                {t('documents.acknowledgments.sendSubmit')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="flex flex-col gap-3">
            <Callout tone={result.added > 0 ? 'success' : 'warning'}>
              {result.added > 0
                ? t('documents.acknowledgments.sent', { count: result.added })
                : t('documents.acknowledgments.nothingSent')}
            </Callout>
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-fg-secondary">
                {t('documents.acknowledgments.skipped')}
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {result.skipped.map((item) => (
                  <li key={item.user.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-fg">{item.user.displayName}</span>
                    <span className="text-xs text-fg-muted">
                      {t(`documents.acknowledgments.skipReasons.${item.reason}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            <Field label={t('documents.acknowledgments.recipients')} required>
              <PrincipalsPicker
                value={recipients}
                onChange={setRecipients}
                label={t('documents.acknowledgments.recipients')}
              />
            </Field>
            <Field
              label={t('documents.acknowledgments.due')}
              hint={t('documents.acknowledgments.dueHint')}
              htmlFor={`${formId}-due`}
            >
              <Input
                id={`${formId}-due`}
                type="date"
                min={localToday()}
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </Field>
            <Switch
              label={t('documents.acknowledgments.requireCode')}
              checked={requireCode}
              onCheckedChange={setRequireCode}
            />
            <Field label={t('documents.acknowledgments.note')} htmlFor={`${formId}-note`}>
              <Textarea
                id={`${formId}-note`}
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
