import type {
  DatasetRecord,
  DatasetRowHistoryEntry,
  FeatureGeometry,
  LayerEditAccess,
  LayerRecord,
  Locale,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { fieldLabel } from '../../data/field-types.js'
import { rowHistoryQuery } from '../../data/queries.js'
import { useStudio } from '../studio/context.js'
import { conflictOf, editApi, editKeys, refreshAfterWrite } from './edit-api.js'
import { editStore } from './edit-store.js'
import { useFieldText } from './field-text.js'
import { splitParts } from './geometry.js'

const asGeometry = (value: unknown): FeatureGeometry | null =>
  value && typeof value === 'object' && 'type' in value ? (value as FeatureGeometry) : null

/**
 * История объекта (07-gis-engine.md §7): версии строки из `ds.h_*` — кто, когда,
 * что изменил; «как было» — прежняя геометрия пунктиром на карте; откат одной
 * правки — её прежние значения новой правкой с текущей версией строки.
 */
export function FeatureHistory({
  layer,
  dataset,
  access,
}: {
  layer: LayerRecord
  dataset: DatasetRecord
  access: LayerEditAccess
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const studio = useStudio()
  const locale = useAppearance((s) => s.locale) as Locale
  const { data: me } = useQuery(meQuery())
  const useSession = editStore(studio.mapId)
  const target = useSession((s) => s.target)
  const ghost = useSession((s) => s.ghost)
  const [reverting, setReverting] = useState<DatasetRowHistoryEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const rowId = target?.rowId ?? null
  const history = useQuery({
    ...rowHistoryQuery(dataset.id, rowId ?? '0'),
    enabled: rowId !== null,
  })
  const byKey = new Map(dataset.fields.map((field) => [field.key, field]))
  const ctx = { locale, ...(me?.user.timezone ? { timezone: me.user.timezone } : {}) }
  const text = useFieldText(dataset)

  if (!target || !rowId) return null
  if (history.error) {
    return (
      <Callout
        tone={history.error instanceof ApiError && history.error.status === 403 ? 'info' : 'danger'}
      >
        {history.error instanceof ApiError ? history.error.message : t('errors.unknown')}
      </Callout>
    )
  }
  if (history.isLoading || !history.data) return <Skeleton className="h-24 w-full" />
  if (history.data.length === 0) {
    return (
      <EmptyState
        compact
        icon={<History />}
        title={t('data.row.historyEmpty')}
        description={dataset.settings.trackHistory ? undefined : t('data.row.historyOff')}
      />
    )
  }

  /** «Как было»: геометрия до правки (у создания — какой объект появился). */
  const shapeOf = (entry: DatasetRowHistoryEntry) =>
    entry.op === 'update'
      ? asGeometry(entry.previous?.[layer.geometryField])
      : asGeometry(entry.values[layer.geometryField])

  const revert = async (entry: DatasetRowHistoryEntry) => {
    if (!target.ver || !entry.previous) return
    setBusy(true)
    const previous = entry.previous
    const geometry = asGeometry(previous[layer.geometryField])
    const values = Object.fromEntries(
      Object.entries(previous).filter(
        ([key]) => key !== layer.geometryField && byKey.has(key) && !byKey.get(key)?.readOnly,
      ),
    )
    try {
      if (access.mode === 'suggest') {
        await editApi.submit(layer.id, {
          op: 'update',
          rowId,
          ver: target.ver,
          values,
          ...(geometry ? { geometry } : {}),
          note: t('gis.edit.history.revertNote', { ver: entry.ver }),
        })
        toast.show({ title: t('gis.edit.submitted'), tone: 'success' })
        void client.invalidateQueries({ queryKey: editKeys.edits(layer.id) })
        return
      }
      const updated = await editApi.update(layer.id, rowId, {
        values,
        ...(geometry ? { geometry } : {}),
        ver: target.ver,
      })
      const saved = (updated.geometry as FeatureGeometry | null) ?? null
      const state = useSession.getState()
      state.open(
        {
          rowId,
          ver: updated.ver,
          values: updated.values,
          original: saved,
          geometryLocked: target.geometryLocked,
        },
        saved,
        updated.values,
      )
      state.setTab('history')
      if (saved && !target.geometryLocked) state.controller?.load(splitParts(saved))
      refreshAfterWrite(client, layer)
      toast.show({ title: t('gis.edit.history.reverted'), tone: 'success' })
    } catch (error) {
      toast.error(
        conflictOf(error)
          ? t('gis.edit.history.conflict')
          : error instanceof ApiError
            ? error.message
            : t('errors.unknown'),
      )
    } finally {
      setBusy(false)
      setReverting(null)
    }
  }

  return (
    <>
      <ol className="flex flex-col gap-2" aria-label={t('gis.edit.tabs.history')}>
        {history.data.map((entry) => {
          const who = entry.changedBy?.displayName ?? t('data.row.system')
          const keys = Object.keys(entry.values).filter(
            (key) => byKey.has(key) || key === layer.geometryField,
          )
          const shape = shapeOf(entry)
          const shown = shape !== null && ghost?.geometry === shape
          // Откат любой правки: поля этой правки — к прежним значениям новой версией
          const canRevert =
            entry.op === 'update' && entry.previous !== null && access.mode !== 'none'
          return (
            <li key={entry.id} className="rounded-md border border-line p-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
                <Avatar name={who} src={entry.changedBy?.avatarUrl ?? null} size="xs" />
                <span className="text-fg">{who}</span>
                <time dateTime={entry.changedAt}>{formatDateTime(entry.changedAt, ctx)}</time>
                <Badge size="sm" tone={entry.op === 'delete' ? 'danger' : 'neutral'}>
                  {t(`data.row.ops.${entry.op}`)}
                </Badge>
                <span className="ml-auto tabular text-fg-muted">
                  {t('data.row.version', { ver: entry.ver })}
                </span>
              </div>
              {keys.length > 0 && entry.op !== 'delete' ? (
                <dl className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
                  {keys.map((key) => {
                    const field = byKey.get(key)
                    return (
                      <div key={key} className="contents">
                        <dt className="truncate text-fg-secondary">
                          {field ? fieldLabel(field, locale) : key}
                        </dt>
                        <dd className="min-w-0 break-words">
                          {key === layer.geometryField ? (
                            <span>
                              {entry.op === 'update'
                                ? t('gis.edit.history.geometryChanged')
                                : t('gis.edit.history.geometrySet')}
                            </span>
                          ) : (
                            <>
                              {entry.op === 'update' ? (
                                <>
                                  <span className="text-fg-muted line-through">
                                    {text(key, entry.previous?.[key])}
                                  </span>
                                  {' → '}
                                </>
                              ) : null}
                              <span>{text(key, entry.values[key])}</span>
                            </>
                          )}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1">
                {shape ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={shown}
                    icon={shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    onClick={() =>
                      useSession
                        .getState()
                        .setGhost(shown ? null : { geometry: shape, tone: 'previous' })
                    }
                  >
                    {shown ? t('gis.edit.history.hide') : t('gis.edit.history.show')}
                  </Button>
                ) : null}
                {canRevert ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    disabled={busy}
                    onClick={() => setReverting(entry)}
                  >
                    {t('gis.edit.history.revert')}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      <AlertDialog
        open={reverting !== null}
        onOpenChange={(open) => !open && setReverting(null)}
        title={t('gis.edit.history.revertTitle')}
        description={t('gis.edit.history.revertBody', { ver: reverting?.ver ?? 0 })}
        confirmLabel={t('gis.edit.history.revert')}
        loading={busy}
        onConfirm={() => {
          if (reverting) void revert(reverting)
        }}
      />
    </>
  )
}
