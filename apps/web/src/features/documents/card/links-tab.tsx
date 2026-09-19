import {
  type CorrespondenceItem,
  DOCUMENT_LINK_KINDS,
  type DocumentLinkKind,
  type LinkView,
  type Locale,
  type ObjectSummary,
} from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  ObjectChip,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Link2, Plus, Reply, X } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { objectLinksQuery, objectListQuery } from '~/shared/api/queries.js'
import { correspondenceQuery } from '../queries.js'
import { DOCUMENT_STATUS_TONE, errorText } from '../status.js'
import { useDocument } from './document-context.js'

/** Виды связей, которые пользователь создаёт между документами в карточке. */
const MANUAL_KINDS: DocumentLinkKind[] = [
  'reply_to',
  'in_execution_of',
  'cancels',
  'amends',
  'related',
]

/** Порядок групп вкладки: переписка и исполнение, дальше — прочие виды документов. */
const KIND_ORDER: readonly string[] = DOCUMENT_LINK_KINDS

/**
 * Вкладка «Связи» (08-documents.md §11, ADR-0086): цепочка переписки по связям
 * «в ответ на» в обе стороны, связи по видам с направлением («в ответ на» /
 * «ответы на него», «во исполнение» / «исполняется»…), новая связь с другим
 * документом. Вложения — во вкладке «Файлы и версии»; недоступные объекты —
 * чипом «нет доступа» без названия.
 */
export function LinksTab() {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const toast = useToast()
  const { document, refresh } = useDocument()
  const { data, isLoading } = useQuery(objectLinksQuery(document.id))
  const [adding, setAdding] = useState(false)
  const links = (data?.links ?? []).filter((link: LinkView) => link.kind !== 'attachment')

  const unlink = useMutation({
    mutationFn: (link: LinkView) =>
      http.delete(`/objects/${document.id}/links/${link.object.id}/${link.kind}`),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const open = (object: ObjectSummary) =>
    openTab({
      kind: 'object',
      objectId: object.id,
      objectType: object.type,
      title: object.subtitle ? `${object.subtitle} · ${object.title}` : object.title,
      mode: 'permanent',
    })

  if (isLoading) return <Skeleton className="m-6 h-24" />
  const groups = KIND_ORDER.flatMap((kind) =>
    (['outgoing', 'incoming'] as const).flatMap((direction) => {
      const items = links.filter((link) => link.kind === kind && link.direction === direction)
      return items.length > 0 ? [{ kind, direction, items }] : []
    }),
  )
  const other = links.filter((link) => !KIND_ORDER.includes(link.kind))

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-5 p-6">
      <Correspondence />
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">
            {t('documents.links.title')}
          </h2>
          {document.can.link ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setAdding(true)}
            >
              {t('documents.links.add')}
            </Button>
          ) : null}
        </div>
        {links.length === 0 ? (
          <EmptyState
            compact
            icon={<Link2 />}
            title={t('objects.links.empty')}
            description={t('documents.links.hint')}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <div key={`${group.kind}:${group.direction}`} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-fg-muted">
                  {t(`documents.links.kinds.${group.kind}.${group.direction}`)}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {group.items.map((link) => (
                    <LinkRow
                      key={link.id}
                      link={link}
                      onOpen={open}
                      onRemove={
                        document.can.link && link.direction === 'outgoing'
                          ? () => unlink.mutate(link)
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
            {other.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {other.map((link) => (
                  <li key={link.id} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 text-xs text-fg-muted">
                      {t(`objects.links.kind.${link.kind}`)}
                    </span>
                    <LinkRow link={link} onOpen={open} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>
      {adding ? <AddLinkDialog onClose={() => setAdding(false)} /> : null}
    </div>
  )
}

function LinkRow({
  link,
  onOpen,
  onRemove,
}: {
  link: LinkView
  onOpen: (object: ObjectSummary) => void
  onRemove?: () => void
}) {
  const t = useT()
  return (
    <li className="flex items-center gap-2">
      <ObjectChip
        object={{
          id: link.object.id,
          type: link.object.type,
          title: link.object.title,
          subtitle: link.object.subtitle,
          accessible: link.object.accessible,
        }}
        onOpen={link.object.accessible ? () => onOpen(link.object) : undefined}
      />
      {onRemove ? (
        <IconButton size="sm" label={t('documents.links.remove')} onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      ) : null}
    </li>
  )
}

/**
 * Цепочка переписки: входящее → ответ → новое входящее… по датам; этот
 * документ выделен, недоступные — без реквизитов.
 */
function Correspondence() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const { document, refresh } = useDocument()
  const { data } = useQuery(correspondenceQuery(document.id))
  const items = data?.items ?? []

  const reply = useMutation({
    mutationFn: () => http.post<{ id: string }>(`/documents/${document.id}/reply`, {}),
    onSuccess: ({ id }) => {
      toast.show({ title: t('documents.reply.created'), tone: 'success' })
      refresh()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'document',
        title: document.subject || t('documents.draft'),
        mode: 'permanent',
      })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  if (items.length < 2 && !document.can.reply) return null
  return (
    <section aria-label={t('documents.correspondence.title')} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">
          {t('documents.correspondence.title')}
        </h2>
        {document.can.reply ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Reply className="size-3.5" />}
            loading={reply.isPending}
            onClick={() => reply.mutate()}
          >
            {t('documents.actions.reply')}
          </Button>
        ) : null}
      </div>
      {items.length < 2 ? (
        <p className="text-xs text-fg-muted">{t('documents.correspondence.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {items.map((item) => (
            <CorrespondenceRow key={item.id} item={item} locale={locale} />
          ))}
        </ol>
      )}
      {data?.truncated ? (
        <Callout tone="info">{t('documents.correspondence.truncated')}</Callout>
      ) : null}
    </section>
  )
}

function CorrespondenceRow({ item, locale }: { item: CorrespondenceItem; locale: Locale }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  if (!item.accessible) {
    return (
      <li className="flex items-center gap-2 rounded-md border border-dashed border-line px-3 py-2 text-xs text-fg-muted">
        {t('documents.correspondence.hidden')}
      </li>
    )
  }
  const Icon = item.direction === 'outgoing' ? ArrowUpRight : ArrowDownLeft
  return (
    <li>
      <button
        type="button"
        aria-current={item.current ? 'true' : undefined}
        disabled={item.current}
        onClick={() =>
          openTab({
            kind: 'object',
            objectId: item.id,
            objectType: 'document',
            title: item.regNumber ? `${item.regNumber} · ${item.subject}` : item.subject,
            mode: 'permanent',
          })
        }
        className={cn(
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm',
          item.current
            ? 'border-accent bg-accent-subtle'
            : 'border-line bg-surface hover:bg-surface-2',
        )}
      >
        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="w-28 shrink-0 text-xs text-fg-muted">
          {item.direction ? t(`documents.directions.${item.direction}`) : ''}
        </span>
        <span className="w-32 shrink-0 font-mono text-xs tabular text-fg-secondary">
          {item.regNumber ?? t('documents.draftShort')}
        </span>
        <span className="w-24 shrink-0 text-xs tabular text-fg-muted">
          {item.regDate ? formatDate(item.regDate, { locale }) : '—'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-fg">{item.subject || t('documents.draft')}</span>
          {item.correspondent || item.sentOn ? (
            <span className="block truncate text-xs text-fg-muted">
              {[
                item.correspondent?.name,
                item.sentOn
                  ? t('documents.correspondence.sent', {
                      date: formatDate(item.sentOn, { locale }),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
        </span>
        {item.current ? (
          <Badge size="sm" tone="accent">
            {t('documents.correspondence.current')}
          </Badge>
        ) : null}
        {item.status ? (
          <StatusBadge
            status={DOCUMENT_STATUS_TONE[item.status]}
            label={t(`documents.statuses.${item.status}`)}
          />
        ) : null}
      </button>
    </li>
  )
}

/** Новая связь с другим документом: вид и документ из поиска по названию. */
function AddLinkDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const { document, refresh } = useDocument()
  const [kind, setKind] = useState<DocumentLinkKind>('related')
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<ObjectSummary | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const q = useDebouncedValue(search.trim(), 250)
  const { data } = useQuery({
    ...objectListQuery({ types: 'document', q, limit: 20 }),
    enabled: q.length > 1,
  })
  const found = (data?.items ?? []).filter((item) => item.id !== document.id)

  const link = useMutation({
    mutationFn: () => http.post(`/objects/${document.id}/links`, { targetId: target?.id, kind }),
    onSuccess: () => {
      toast.show({ title: t('documents.links.added'), tone: 'success' })
      refresh()
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.links.add')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!target}
              loading={link.isPending}
              onClick={() => link.mutate()}
            >
              {t('documents.links.link')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.links.kind')}>
            <Select value={kind} onValueChange={(next) => setKind(next as DocumentLinkKind)}>
              <SelectTrigger aria-label={t('documents.links.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`documents.links.kinds.${value}.outgoing`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('documents.links.target')}>
            <SearchInput
              value={search}
              onValueChange={(value) => {
                setSearch(value)
                setTarget(null)
              }}
              placeholder={t('documents.links.searchPlaceholder')}
            />
          </Field>
          {target ? (
            <ObjectChip
              object={{
                id: target.id,
                type: 'document',
                title: target.title,
                subtitle: target.subtitle,
              }}
            />
          ) : q.length > 1 ? (
            <ul
              aria-label={t('documents.links.results')}
              className="flex max-h-60 flex-col gap-1 overflow-y-auto"
            >
              {found.length === 0 ? (
                <li className="text-xs text-fg-muted">{t('documents.links.nothing')}</li>
              ) : (
                found.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                      onClick={() => setTarget(item)}
                    >
                      <span className="w-32 shrink-0 font-mono text-xs tabular text-fg-secondary">
                        {item.subtitle ?? t('documents.draftShort')}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
