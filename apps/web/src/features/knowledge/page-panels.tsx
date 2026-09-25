import {
  type ObjectAcknowledgments,
  type PageRecord,
  type PrincipalRef,
  REVIEWED_PAGE_TEMPLATES,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, UserCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { PrincipalsPicker } from '~/features/documents/principals-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { knowledgeKeys } from './queries.js'

const failedText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback

/**
 * Ознакомление со страницей (ADR-0084, ADR-0095): просьба и отметка — читателю,
 * отправка и сводка — тому, кто распоряжается страницей. Учёт ведёт ядро,
 * поэтому здесь только его сводка по объекту страницы.
 */
export function PageAcknowledgments({ page }: { page: PageRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [sendOpen, setSendOpen] = useState(false)
  const { data } = useQuery({
    queryKey: knowledgeKeys.acknowledgments(page.id),
    queryFn: () => http.get<ObjectAcknowledgments>(`/objects/${page.id}/acknowledgments`),
    enabled: page.status === 'published' || page.acknowledgmentRequested,
  })

  const acknowledge = useMutation({
    mutationFn: () =>
      http.post<ObjectAcknowledgments>(`/objects/${page.id}/acknowledgments/acknowledge`, {}),
    onSuccess: (next) => {
      client.setQueryData(knowledgeKeys.acknowledgments(page.id), next)
      void client.invalidateQueries({ queryKey: ['inbox'] })
      toast.show({ title: t('knowledge.ack.done'), tone: 'success' })
    },
    onError: (error) => toast.error(failedText(error, t('errors.unknown'))),
  })

  const mine = data?.mine.pending ?? false
  const total = data?.summary.total ?? 0

  return (
    <section className="flex flex-col gap-2" aria-label={t('knowledge.ack.title')}>
      {mine ? (
        <Callout
          tone="info"
          title={t('knowledge.ack.mine')}
          action={
            <Button size="sm" onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>
              <UserCheck className="size-4" />
              {t('knowledge.ack.mark')}
            </Button>
          }
        >
          {t('knowledge.ack.mineHint')}
        </Callout>
      ) : null}
      {total > 0 && !mine ? (
        <p className="text-xs text-fg-muted" data-testid="page-ack-summary">
          {t('knowledge.ack.summary', {
            acknowledged: data?.summary.acknowledged ?? 0,
            total,
          })}
        </p>
      ) : null}
      {page.can.requestAcknowledgment ? (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setSendOpen(true)}>
            <Send className="size-4" />
            {t('knowledge.ack.request')}
          </Button>
        </div>
      ) : null}
      {sendOpen ? <SendDialog page={page} onClose={() => setSendOpen(false)} /> : null}
    </section>
  )
}

/** Кого ознакомить: сотрудники и подразделения, срок и подтверждение кодом. */
function SendDialog({ page, onClose }: { page: PageRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const dueId = useId()
  const [principals, setPrincipals] = useState<PrincipalRef[]>([])
  const [due, setDue] = useState('')
  const [secondFactor, setSecondFactor] = useState(false)
  const [note, setNote] = useState('')

  const send = useMutation({
    mutationFn: () =>
      http.post<{ requested: number }>(`/pages/${page.id}/acknowledgments`, {
        userIds: principals.filter((item) => item.type === 'user').map((item) => item.id),
        unitIds: principals.filter((item) => item.type === 'unit').map((item) => item.id),
        dueAt: due || null,
        requireSecondFactor: secondFactor,
        note: note || null,
      }),
    onSuccess: (result) => {
      toast.show({
        title: t('knowledge.ack.requested', { count: result.requested }),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: knowledgeKeys.acknowledgments(page.id) })
      void client.invalidateQueries({ queryKey: knowledgeKeys.page(page.id) })
      onClose()
    },
    onError: (error) => toast.error(failedText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('knowledge.ack.requestTitle')}>
        <div className="flex flex-col gap-3">
          <PrincipalsPicker
            value={principals}
            onChange={setPrincipals}
            label={t('knowledge.ack.people')}
            types="user,unit"
          />
          <Field label={t('knowledge.ack.due')} htmlFor={dueId}>
            <Input
              id={dueId}
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
          </Field>
          <Switch
            checked={secondFactor}
            onCheckedChange={setSecondFactor}
            label={t('knowledge.ack.secondFactor')}
          />
          <Field label={t('knowledge.ack.note')}>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-label={t('knowledge.ack.note')}
              rows={2}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              onClick={() => send.mutate()}
              disabled={send.isPending || principals.length === 0}
            >
              {t('knowledge.ack.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Пересмотр страницы (ADR-0095): владелец и срок. Когда срок подходит, задание
 * переводит страницу в «на пересмотре» и открывает владельцу дело.
 */
export function PageReview({ page }: { page: PageRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const dueId = useId()
  const [reviewAt, setReviewAt] = useState(page.reviewAt ?? '')

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      http.patch<PageRecord>(`/pages/${page.id}`, patch),
    onSuccess: () => {
      toast.show({ title: t('knowledge.review.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: knowledgeKeys.page(page.id) })
    },
    onError: (error) => toast.error(failedText(error, t('errors.unknown'))),
  })

  return (
    <section className="flex flex-col gap-3" aria-label={t('knowledge.review.title')}>
      {page.status === 'review' ? (
        <Callout tone="warning" title={t('knowledge.review.inReview')}>
          {t('knowledge.review.inReviewHint')}
        </Callout>
      ) : null}
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-2xs uppercase text-fg-muted">{t('knowledge.review.owner')}</dt>
          <dd className="text-sm text-fg">
            {page.owner?.displayName ?? t('knowledge.review.ownerNone')}
          </dd>
        </div>
        <div>
          <dt className="text-2xs uppercase text-fg-muted">{t('knowledge.review.dueAt')}</dt>
          <dd className="text-sm text-fg">{page.reviewAt ?? t('knowledge.review.dueNone')}</dd>
        </div>
      </dl>
      {page.can.manage ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('knowledge.review.dueAt')} htmlFor={dueId}>
            <Input
              id={dueId}
              type="date"
              value={reviewAt}
              onChange={(event) => setReviewAt(event.target.value)}
            />
          </Field>
          <Button
            size="sm"
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ reviewAt: reviewAt || null })}
          >
            {t('common.actions.save')}
          </Button>
          {page.status === 'published' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: 'review' })}
            >
              {t('knowledge.review.send')}
            </Button>
          ) : null}
          {page.status !== 'draft' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: 'draft' })}
            >
              {t('knowledge.review.backToDraft')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <PageAcknowledgments page={page} />
    </section>
  )
}

/** Сегодня через год — `ГГГГ-ММ-ДД` по часам смотрящего. */
function yearFromToday(): string {
  const now = new Date()
  const next = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
}

/**
 * Публикация: примечание к версии и следующий срок пересмотра. Регламенту и инструкции
 * срок подставляется сам — год от публикации (N35); его можно поменять, но не убрать.
 */
export function PublishDialog({ page, onClose }: { page: PageRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const dueId = useId()
  const reviewed = REVIEWED_PAGE_TEMPLATES.includes(page.template)
  const [note, setNote] = useState('')
  const [reviewAt, setReviewAt] = useState(reviewed ? yearFromToday() : (page.reviewAt ?? ''))

  const publish = useMutation({
    mutationFn: () =>
      http.post<PageRecord>(`/pages/${page.id}/publish`, {
        note: note || null,
        reviewAt: reviewAt || null,
      }),
    onSuccess: () => {
      toast.show({ title: t('knowledge.publish.done'), tone: 'success' })
      void client.invalidateQueries({ queryKey: knowledgeKeys.page(page.id) })
      void client.invalidateQueries({ queryKey: knowledgeKeys.versions(page.id) })
      void client.invalidateQueries({ queryKey: ['knowledge', 'tree'] })
      void client.invalidateQueries({ queryKey: ['inbox'] })
      onClose()
    },
    onError: (error) => toast.error(failedText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('knowledge.publish.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-fg-muted">
            {t('knowledge.publish.hint', { number: page.versionNumber + 1 })}
          </p>
          <Field label={t('knowledge.publish.note')}>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-label={t('knowledge.publish.note')}
              rows={2}
            />
          </Field>
          <Field
            label={t('knowledge.publish.reviewAt')}
            htmlFor={dueId}
            {...(reviewed ? { hint: t('knowledge.publish.reviewYear') } : {})}
          >
            <Input
              id={dueId}
              type="date"
              value={reviewAt}
              onChange={(event) => setReviewAt(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
              {t('knowledge.publish.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
