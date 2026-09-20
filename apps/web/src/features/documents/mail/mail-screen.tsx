import type { MailMessageList, MailMessageRecord, MailPollReport } from '@kchs/contracts'
import { formatDateTime, formatFileSize } from '@kchs/fields'
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  KeyValueList,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Ban, Download, Mail, RefreshCw, Stamp } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { http } from '~/shared/api/client.js'
import { errorText } from '../status.js'

/**
 * Очередь «Из почты» (08-documents.md §5, ADR-0113): слева письма ящика
 * канцелярии, справа предпросмотр письма с вложениями. «Зарегистрировать»
 * открывает черновик, заведённый из письма, — регистрацию с номером из журнала
 * делает существующая карточка документа. Отклонение — с причиной.
 */

type Scope = 'draft' | 'all'

const STATUS_TONE: Record<string, 'accent' | 'success' | 'neutral' | 'danger'> = {
  draft: 'accent',
  registered: 'success',
  rejected: 'neutral',
  failed: 'danger',
}

export const mailKeys = {
  list: (scope: Scope) => ['documents', 'mail', scope] as const,
}

export function MailScreen() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [scope, setScope] = useState<Scope>('draft')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: mailKeys.list(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      http.get<MailMessageList>('/documents/mail', {
        query: {
          ...(scope === 'draft' ? { status: 'draft' } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

  const items = data?.pages.flatMap((page) => page.items) ?? []
  const pending = data?.pages[0]?.pending ?? 0
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null

  const poll = useMutation({
    mutationFn: () => http.post<MailPollReport>('/documents/mail/poll'),
    onSuccess: (report) => {
      toast.show({
        title: t('documents.mail.polled', {
          created: report.result.created,
          fetched: report.result.fetched,
        }),
        tone: report.errors.length > 0 ? 'warning' : 'success',
      })
      void client.invalidateQueries({ queryKey: ['documents', 'mail'] })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <h1 className="text-sm font-semibold text-fg">{t('documents.mail.title')}</h1>
            <Badge size="sm" tone={pending > 0 ? 'accent' : undefined}>
              {t('documents.mail.pending', { count: pending })}
            </Badge>
          </>
        }
        right={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('documents.mail.scopeLabel')}
              value={scope}
              onValueChange={(next) => {
                setScope(next as Scope)
                setSelectedId(null)
              }}
              options={[
                { value: 'draft', label: t('documents.mail.filters.pending') },
                { value: 'all', label: t('documents.mail.filters.all') },
              ]}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={poll.isPending}
              onClick={() => poll.mutate()}
            >
              {t('documents.mail.poll')}
            </Button>
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,380px)_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon={<Mail />}
              title={t('documents.mail.empty')}
              description={t('documents.mail.emptyHint')}
            />
          ) : (
            <>
              <ul className="divide-y divide-line" aria-label={t('documents.mail.title')}>
                {items.map((item) => (
                  <li key={item.id}>
                    <MailRow
                      item={item}
                      selected={selected?.id === item.id}
                      onSelect={() => setSelectedId(item.id)}
                    />
                  </li>
                ))}
              </ul>
              {hasNextPage ? (
                <div className="p-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {t('common.actions.loadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto bg-canvas">
          {selected ? (
            <MailDetail item={selected} />
          ) : (
            <EmptyState
              icon={<Mail />}
              title={t('documents.mail.empty')}
              description={t('documents.mail.emptyHint')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function MailRow({
  item,
  selected,
  onSelect,
}: {
  item: MailMessageRecord
  selected: boolean
  onSelect: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 px-3 py-2.5 text-left',
        selected ? 'bg-accent-subtle' : 'hover:bg-surface-2',
      )}
    >
      <span className="flex items-center gap-2">
        <Mail className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {item.subject || t('documents.mail.noSubject')}
        </span>
        <Badge size="sm" tone={STATUS_TONE[item.status]}>
          {t(`documents.mail.status.${item.status}`)}
        </Badge>
      </span>
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="min-w-0 flex-1 truncate">{item.fromName ?? item.fromEmail}</span>
        {item.attachments.length > 0 ? (
          <span className="tabular">
            {t('documents.mail.attachmentsCount', { count: item.attachments.length })}
          </span>
        ) : null}
        <span className="shrink-0">{formatDateTime(item.receivedAt, { locale })}</span>
      </span>
    </button>
  )
}

function MailDetail({ item }: { item: MailMessageRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const download = useFileDownload()
  const reasonId = useId()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const reject = useMutation({
    mutationFn: () => http.post(`/documents/mail/${item.id}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      setRejecting(false)
      setReason('')
      toast.show({ title: t('documents.mail.rejected'), tone: 'info' })
      void client.invalidateQueries({ queryKey: ['documents', 'mail'] })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const openDraft = () => {
    if (!item.documentId) return
    openTab({
      kind: 'object',
      objectId: item.documentId,
      objectType: 'document',
      title: item.subject || t('documents.mail.noSubject'),
      mode: 'permanent',
    })
  }

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
      <header className="flex flex-col gap-2">
        <h2 className="text-md font-semibold text-fg">
          {item.subject || t('documents.mail.noSubject')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge size="sm" tone={STATUS_TONE[item.status]}>
            {t(`documents.mail.status.${item.status}`)}
          </Badge>
          {item.documentRegNumber ? (
            <Badge size="sm" tone="success">
              {item.documentRegNumber}
            </Badge>
          ) : null}
          {item.status === 'draft' ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Stamp className="size-3.5" />}
                disabled={!item.documentId}
                onClick={openDraft}
              >
                {t('documents.actions.register')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Ban className="size-3.5" />}
                onClick={() => setRejecting(true)}
              >
                {t('documents.mail.reject')}
              </Button>
            </>
          ) : null}
          {item.status !== 'draft' && item.documentId ? (
            <Button variant="secondary" size="sm" onClick={openDraft}>
              {t('documents.mail.openDocument')}
            </Button>
          ) : null}
        </div>
      </header>

      {item.error ? (
        <Card title={t('documents.mail.error')}>
          <p className="text-sm text-danger">{item.error}</p>
        </Card>
      ) : null}
      {item.rejectReason ? (
        <Card title={t('documents.mail.rejectReason')}>
          <p className="text-sm text-fg-secondary">{item.rejectReason}</p>
        </Card>
      ) : null}

      <Card title={t('documents.mail.letter')}>
        <KeyValueList
          items={[
            {
              key: 'from',
              label: t('documents.mail.from'),
              value: item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail,
            },
            { key: 'to', label: t('documents.mail.to'), value: item.toEmail ?? '—' },
            {
              key: 'sent',
              label: t('documents.mail.sentAt'),
              value: item.sentAt ? formatDateTime(item.sentAt, { locale }) : '—',
            },
            {
              key: 'received',
              label: t('documents.mail.receivedAt'),
              value: formatDateTime(item.receivedAt, { locale }),
            },
            {
              key: 'correspondent',
              label: t('documents.correspondents.one'),
              value: item.correspondent ? (
                item.correspondent.name
              ) : (
                <span className="text-warning">
                  {t('documents.mail.correspondentMissing', {
                    name: item.suggestedCorrespondentName ?? item.fromEmail,
                  })}
                </span>
              ),
            },
            {
              key: 'mailbox',
              label: t('documents.mail.mailbox'),
              value: item.integrationName ?? '—',
            },
          ]}
        />
      </Card>

      <Card title={t('documents.mail.body')}>
        {item.body ? (
          <p className="whitespace-pre-wrap text-sm text-fg-secondary">{item.body}</p>
        ) : (
          <p className="text-sm text-fg-muted">{t('documents.mail.bodyEmpty')}</p>
        )}
      </Card>

      {item.attachments.length > 0 ? (
        <Card title={t('documents.mail.attachments')} padded={false}>
          <ul className="divide-y divide-line">
            {item.attachments.map((file) => (
              <li key={file.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <ObjectIcon type="file" className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-fg">{file.name}</span>
                <span className="shrink-0 tabular text-xs text-fg-muted">
                  {formatFileSize(file.size, { locale })}
                </span>
                <IconButton
                  size="sm"
                  label={t('common.actions.download')}
                  onClick={() => download.mutate({ fileId: file.id })}
                >
                  <Download className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent title={t('documents.mail.rejectTitle')}>
          <Field label={t('documents.mail.rejectReason')} htmlFor={reasonId}>
            <Textarea
              id={reasonId}
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={reason.trim().length < 3}
              loading={reject.isPending}
              onClick={() => reject.mutate()}
            >
              {t('documents.mail.reject')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
