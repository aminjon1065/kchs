import type { PageVersionRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitCompare, History, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { knowledgeKeys, pageCompareQuery, pageVersionsQuery } from './queries.js'

/** «Текущий текст» в выборе версии — сравнение со снимком страницы. */
const CURRENT = '__current'

/**
 * Версии страницы (ADR-0095): снимок при публикации и по кнопке, сравнение по
 * словам и откат. Откат сохраняет текущий текст версией — вернуться можно
 * всегда.
 */
export function PageVersions({
  pageId,
  canEdit,
  canManage,
}: {
  pageId: string
  canEdit: boolean
  canManage: boolean
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: versions, isLoading } = useQuery(pageVersionsQuery(pageId))
  const [note, setNote] = useState('')
  const [compareOpen, setCompareOpen] = useState(false)

  const failed = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
  const refresh = () => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.versions(pageId) })
    void client.invalidateQueries({ queryKey: knowledgeKeys.page(pageId) })
  }

  const save = useMutation({
    mutationFn: () =>
      http.post<PageVersionRecord>(`/pages/${pageId}/versions`, { note: note || null }),
    onSuccess: () => {
      setNote('')
      toast.show({ title: t('knowledge.versions.saved'), tone: 'success' })
      refresh()
    },
    onError: failed,
  })

  const restore = useMutation({
    mutationFn: (versionId: string) =>
      http.post<PageVersionRecord>(`/pages/${pageId}/versions/${versionId}/restore`, {}),
    onSuccess: (version) => {
      toast.show({
        title: t('knowledge.versions.restored', { number: version.number }),
        tone: 'success',
      })
      refresh()
    },
    onError: failed,
  })

  if (isLoading) return <Skeleton className="h-40" />
  const items = versions ?? []

  return (
    <section className="flex flex-col gap-3" aria-label={t('knowledge.versions.title')}>
      <div className="flex flex-wrap items-end gap-2">
        {canEdit ? (
          <>
            <Field label={t('knowledge.versions.note')} className="min-w-56 flex-1">
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('knowledge.versions.notePlaceholder')}
                aria-label={t('knowledge.versions.note')}
              />
            </Field>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              <History className="size-4" />
              {t('knowledge.versions.save')}
            </Button>
          </>
        ) : null}
        {items.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => setCompareOpen(true)}>
            <GitCompare className="size-4" />
            {t('knowledge.compare.open')}
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={t('knowledge.versions.empty')}
          description={t('knowledge.versions.emptyHint')}
        />
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2"
            >
              <Badge tone="neutral">
                {t('knowledge.versions.number', { number: version.number })}
              </Badge>
              <Badge tone="outline">{t(`knowledge.versions.reason.${version.reason}`)}</Badge>
              <span className="text-xs text-fg-muted">
                {version.createdBy?.displayName ?? ''} ·{' '}
                {formatDateTime(version.createdAt, { locale })}
              </span>
              {version.note ? <span className="text-xs text-fg">{version.note}</span> : null}
              <div className="flex-1" />
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(version.id)}
                >
                  <Undo2 className="size-4" />
                  {t('knowledge.versions.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {compareOpen ? (
        <CompareDialog pageId={pageId} versions={items} onClose={() => setCompareOpen(false)} />
      ) : null}
    </section>
  )
}

/** Сравнение двух версий страницы или версии с текущим текстом. */
function CompareDialog({
  pageId,
  versions,
  onClose,
}: {
  pageId: string
  versions: PageVersionRecord[]
  onClose: () => void
}) {
  const t = useT()
  // Версии — от новой к старой: по умолчанию последняя против текущего текста
  const [fromId, setFromId] = useState(versions[0]?.id ?? '')
  const [toId, setToId] = useState(CURRENT)
  const { data, isLoading } = useQuery(
    pageCompareQuery(pageId, fromId, toId === CURRENT ? '' : toId),
  )

  const picker = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    withCurrent: boolean,
  ) => (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {withCurrent ? (
            <SelectItem value={CURRENT}>{t('knowledge.versions.current')}</SelectItem>
          ) : null}
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              {t('knowledge.versions.number', { number: version.number })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )

  const changed = data ? data.stats.inserted + data.stats.deleted > 0 : false

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('knowledge.compare.title')} size="xl">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {picker(t('knowledge.compare.from'), fromId, setFromId, false)}
            {picker(t('knowledge.compare.to'), toId, setToId, true)}
          </div>
          {isLoading || !data ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <p className="text-xs text-fg-secondary" aria-live="polite">
                {changed
                  ? t('knowledge.compare.stats', {
                      inserted: data.stats.inserted,
                      deleted: data.stats.deleted,
                    })
                  : t('knowledge.compare.empty')}
                {data.truncated ? ` ${t('knowledge.compare.truncated')}` : ''}
              </p>
              <section
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-4 text-sm leading-relaxed text-fg"
                aria-label={t('knowledge.compare.title')}
              >
                {data.segments.map((segment, index) =>
                  segment.op === 'insert' ? (
                    <ins
                      key={index}
                      className="rounded-xs bg-success-subtle text-success underline underline-offset-2"
                    >
                      {segment.text}
                    </ins>
                  ) : segment.op === 'delete' ? (
                    <del
                      key={index}
                      className="rounded-xs bg-danger-subtle text-danger line-through"
                    >
                      {segment.text}
                    </del>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
              </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
