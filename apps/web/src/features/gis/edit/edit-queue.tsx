import type {
  DatasetRecord,
  FeatureEdit,
  FeatureGeometry,
  LayerEditAccess,
  LayerRecord,
  Locale,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  SegmentedControl,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eye, EyeOff, Inbox, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { fieldLabel } from '../../data/field-types.js'
import { useStudio } from '../studio/context.js'
import { ConflictDialog } from './conflict-dialog.js'
import {
  conflictOf,
  editApi,
  editKeys,
  featureEditsQuery,
  type RowConflict,
  refreshAfterWrite,
} from './edit-api.js'
import { editStore } from './edit-store.js'
import { useFieldText } from './field-text.js'
import { bboxOf } from './geometry.js'

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' } as const

/**
 * Правки модерируемого слоя (07-gis-engine.md §7, ADR-0076): проверяющему —
 * очередь «на проверке» с решением «принять / отклонить», автору — свои правки
 * со статусом и комментарием проверяющего. «Показать» — предложенная геометрия
 * пунктиром на карте.
 */
export function EditQueue({
  layer,
  dataset,
  access,
}: {
  layer: LayerRecord
  dataset: DatasetRecord
  access: LayerEditAccess
}) {
  const t = useT()
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const scope = access.canReview ? 'all' : 'mine'
  const edits = useQuery(
    featureEditsQuery(layer.id, scope, filter === 'pending' ? 'pending' : undefined),
  )
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        size="sm"
        aria-label={t('gis.edit.queue.filter')}
        value={filter}
        onValueChange={setFilter}
        options={[
          { value: 'pending', label: t('gis.edit.queue.pending') },
          { value: 'all', label: t('gis.edit.queue.all') },
        ]}
      />
      {edits.error ? (
        <Callout tone="danger">
          {edits.error instanceof ApiError ? edits.error.message : t('errors.unknown')}
        </Callout>
      ) : edits.isLoading || !edits.data ? (
        <Skeleton className="h-20 w-full" />
      ) : edits.data.length === 0 ? (
        <EmptyState
          compact
          icon={<Inbox />}
          title={access.canReview ? t('gis.edit.queue.emptyReview') : t('gis.edit.queue.emptyMine')}
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('gis.edit.tabs.edits')}>
          {edits.data.map((edit) => (
            <EditItem
              key={edit.id}
              edit={edit}
              layer={layer}
              dataset={dataset}
              canReview={access.canReview}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function EditItem({
  edit,
  layer,
  dataset,
  canReview,
}: {
  edit: FeatureEdit
  layer: LayerRecord
  dataset: DatasetRecord
  canReview: boolean
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const studio = useStudio()
  const commentId = useId()
  const locale = useAppearance((s) => s.locale) as Locale
  const { data: me } = useQuery(meQuery())
  const useSession = editStore(studio.mapId)
  const ghost = useSession((s) => s.ghost)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<RowConflict | null>(null)
  /** Геометрия правки на карте: предложенная, у удаления — удаляемый объект. */
  const [shape, setShape] = useState<FeatureGeometry | null>(null)
  const ctx = { locale, ...(me?.user.timezone ? { timezone: me.user.timezone } : {}) }
  const text = useFieldText(dataset)
  const byKey = new Map(dataset.fields.map((field) => [field.key, field]))
  const geometry = edit.geometry as FeatureGeometry | null
  const shown = shape !== null && ghost?.geometry === shape
  const who = edit.author?.displayName ?? t('data.row.system')

  const show = async () => {
    const state = useSession.getState()
    if (shown) {
      state.setGhost(null)
      return
    }
    // Удаление: показать удаляемый объект, как он есть сейчас
    let next = geometry
    if (!next && edit.rowId) {
      try {
        next = (await editApi.feature(layer.id, edit.rowId)).geometry as FeatureGeometry | null
      } catch {
        next = null
      }
    }
    if (!next) return
    setShape(next)
    state.setGhost({ geometry: next, tone: 'proposed' })
    const bbox = bboxOf(next)
    if (bbox) studio.fitBounds(bbox)
    if (edit.rowId) studio.setSelection([{ layerId: layer.id, rowId: edit.rowId }])
  }

  const decide = async (decision: 'approve' | 'reject', force = false) => {
    setBusy(true)
    try {
      await editApi.review(layer.id, edit.id, {
        decision,
        force,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      })
      toast.show({
        title: decision === 'approve' ? t('gis.edit.queue.approved') : t('gis.edit.queue.rejected'),
        tone: 'success',
      })
      setRejecting(false)
      setConflict(null)
      if (shown) useSession.getState().setGhost(null)
      void client.invalidateQueries({ queryKey: editKeys.edits(layer.id) })
      void client.invalidateQueries({ queryKey: editKeys.access(layer.id) })
      if (decision === 'approve') refreshAfterWrite(client, layer)
    } catch (error) {
      const conflicted = conflictOf(error)
      if (conflicted) setConflict(conflicted)
      else toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    } finally {
      setBusy(false)
    }
  }

  const keys = Object.keys(edit.values)
  return (
    <li className="rounded-md border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
        <Avatar name={who} src={edit.author?.avatarUrl ?? null} size="xs" />
        <span className="text-fg">{who}</span>
        <time dateTime={edit.createdAt}>{formatDateTime(edit.createdAt, ctx)}</time>
        <Badge size="sm" tone={edit.op === 'delete' ? 'danger' : 'accent'}>
          {t(`gis.edit.ops.${edit.op}`)}
        </Badge>
        <Badge size="sm" tone={STATUS_TONE[edit.status]} className="ml-auto">
          {t(`gis.edit.status.${edit.status}`)}
        </Badge>
      </div>
      {edit.rowId ? (
        <p className="mt-1 text-xs text-fg-muted">
          {t('gis.edit.featureTitle', { id: edit.rowId })}
        </p>
      ) : null}
      {keys.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
          {keys.map((key) => {
            const field = byKey.get(key)
            return (
              <div key={key} className="contents">
                <dt className="truncate text-fg-secondary">
                  {field ? fieldLabel(field, locale) : key}
                </dt>
                <dd className="min-w-0 break-words">{text(key, edit.values[key])}</dd>
              </div>
            )
          })}
        </dl>
      ) : null}
      {geometry ? (
        <p className="mt-1 text-xs text-fg-muted">{t('gis.edit.queue.geometryChanged')}</p>
      ) : null}
      {edit.note ? <p className="mt-2 text-sm text-fg-secondary">{edit.note}</p> : null}
      {edit.comment ? (
        <p className="mt-2 border-l-2 border-line pl-2 text-sm text-fg-secondary">
          {edit.reviewer?.displayName ? `${edit.reviewer.displayName}: ` : null}
          {edit.comment}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {geometry || edit.rowId ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={shown}
            icon={shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            onClick={() => void show()}
          >
            {shown ? t('gis.edit.history.hide') : t('gis.edit.queue.show')}
          </Button>
        ) : null}
        {canReview && edit.status === 'pending' ? (
          <>
            <Button
              variant="primary"
              size="sm"
              icon={<Check className="size-3.5" />}
              loading={busy && !rejecting}
              disabled={busy}
              onClick={() => void decide('approve')}
            >
              {t('gis.edit.queue.approve')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="size-3.5" />}
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              {t('gis.edit.queue.reject')}
            </Button>
          </>
        ) : null}
      </div>
      <Dialog open={rejecting} onOpenChange={(open) => !open && setRejecting(false)}>
        {rejecting ? (
          <DialogContent
            title={t('gis.edit.queue.rejectTitle')}
            size="sm"
            footer={
              <>
                <Button variant="secondary" onClick={() => setRejecting(false)}>
                  {t('common.actions.cancel')}
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void decide('reject')}>
                  {t('gis.edit.queue.reject')}
                </Button>
              </>
            }
          >
            <Field label={t('gis.edit.queue.comment')} htmlFor={commentId}>
              <Textarea
                id={commentId}
                rows={3}
                autoFocus
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
          </DialogContent>
        ) : null}
      </Dialog>
      {conflict ? (
        <ConflictDialog
          dataset={dataset}
          geometryField={layer.geometryField}
          mine={{
            ...edit.values,
            ...(geometry ? { [layer.geometryField]: geometry } : {}),
          }}
          conflict={conflict}
          busy={busy}
          overwriteLabel={t('gis.edit.queue.applyAnyway')}
          discardLabel={t('gis.edit.queue.reject')}
          mineLabel={t('gis.edit.queue.proposed')}
          onOverwrite={() => void decide('approve', true)}
          onDiscard={() => {
            setConflict(null)
            setRejecting(true)
          }}
          onClose={() => setConflict(null)}
        />
      ) : null}
    </li>
  )
}
