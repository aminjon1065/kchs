import type {
  DatasetField,
  DatasetRecord,
  FeatureEditInput,
  FeatureGeometry,
  LayerEditAccess,
  LayerFeature,
  LayerRecord,
  Locale,
} from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  type ControlProps,
  Field,
  SchemaForm,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, Undo2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { useFieldOptions } from '../../data/field-options.js'
import { useStudio } from '../studio/context.js'
import { ConflictDialog } from './conflict-dialog.js'
import {
  conflictOf,
  editApi,
  editKeys,
  type RowConflict,
  refreshAfterWrite,
  reverseGeocodeQuery,
} from './edit-api.js'
import { editStore } from './edit-store.js'
import { representativePoint, sameGeometry, splitParts } from './geometry.js'
import { TerritoryField } from './territory-field.js'

/** Типы, которые форма не правит: вычисляемые и геометрия (она — на карте). */
const NOT_IN_FORM = new Set(['geometry', 'formula', 'lookup', 'rollup'])

const isEmpty = (value: unknown) => value === null || value === undefined || value === ''
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Операция, которую повторяют после конфликта версии с новой версией строки. */
type Pending =
  | { kind: 'save'; values: Record<string, unknown>; geometry: FeatureGeometry | null }
  | { kind: 'delete' }

/** Поле, в которое ставится территория по карте: поле территории датасета или первое такого типа. */
export function territoryFieldOf(dataset: DatasetRecord): DatasetField | null {
  const key = dataset.territoryField
  const byRole = key ? dataset.fields.find((field) => field.key === key) : undefined
  return byRole?.type === 'territory'
    ? byRole
    : (dataset.fields.find((field) => field.type === 'territory') ?? null)
}

/**
 * Атрибуты объекта (07-gis-engine.md §7, ADR-0076): форма по схеме датасета
 * (`SchemaForm`) с проверкой, справочниками и территорией по карте. Запись —
 * через слой: напрямую или на проверку (модерируемый слой); устаревшая версия —
 * диалог различий «перезаписать / отменить мою правку».
 */
export function FeatureForm({
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
  const noteId = useId()
  const useSession = editStore(studio.mapId)
  const target = useSession((s) => s.target)
  const geometry = useSession((s) => s.geometry)
  const values = useSession((s) => s.values)
  const autoTerritory = useSession((s) => s.autoTerritory)
  const setValues = useSession((s) => s.setValues)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [conflict, setConflict] = useState<{ conflict: RowConflict; pending: Pending } | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const fieldOptions = useFieldOptions(dataset.fields)
  const suggest = access.mode === 'suggest'

  const fields = dataset.fields.filter((field) => !NOT_IN_FORM.has(field.type) && !field.readOnly)
  const territoryField = territoryFieldOf(dataset)

  // Территория по карте: единица самого мелкого уровня, покрывающая точку объекта
  const point = territoryField ? representativePoint(geometry) : null
  const { data: reverse } = useQuery(reverseGeocodeQuery(point))
  const suggestion = reverse?.chain.at(-1) ?? null
  useEffect(() => {
    if (!territoryField || !suggestion) return
    const state = useSession.getState()
    const current = state.values[territoryField.key]
    // Новый объект или перенесённый — пустое поле заполняется по карте; подставленное
    // раньше — обновляется; выбранное вручную и у нетронутого объекта — только подсказка
    const placed = !target?.rowId || !sameGeometry(geometry, target.original)
    if (((isEmpty(current) && placed) || state.autoTerritory) && current !== suggestion.id) {
      state.setValues({ ...state.values, [territoryField.key]: suggestion.id }, true)
    }
  }, [suggestion, territoryField, useSession, target, geometry])

  if (!target) return null

  const finish = (feature: LayerFeature, formValues: Record<string, unknown>) => {
    const saved = (feature.geometry as FeatureGeometry | null) ?? geometry
    useSession.getState().open(
      {
        rowId: feature.id,
        ver: feature.ver,
        values: { ...formValues, ...feature.values },
        original: saved,
        geometryLocked: target.geometryLocked,
      },
      saved,
      { ...formValues, ...feature.values },
    )
    // Черновик — в исправленной сервером форме (кольца, составные части)
    if (saved && !target.geometryLocked) {
      useSession.getState().controller?.load(splitParts(saved))
    }
    studio.setSelection([{ layerId: layer.id, rowId: feature.id }])
    refreshAfterWrite(client, layer)
  }

  const afterSubmit = () => {
    toast.show({ title: t('gis.edit.submitted'), tone: 'success' })
    void client.invalidateQueries({ queryKey: editKeys.edits(layer.id) })
    void client.invalidateQueries({ queryKey: editKeys.access(layer.id) })
    setNote('')
    useSession.getState().controller?.clear()
    useSession.getState().discard()
    useSession.getState().setTab('edits')
    studio.setSelection([])
  }

  const fail = (error: unknown, pending: Pending) => {
    const conflicted = conflictOf(error)
    if (conflicted) {
      setConflict({ conflict: conflicted, pending })
      return
    }
    setServerErrors(error instanceof ApiError ? error.fieldErrors() : {})
    setFailure(error instanceof ApiError ? error.message : t('errors.unknown'))
  }

  /** Запись: создать, изменить (только изменённые поля и геометрия) или удалить. */
  const run = async (pending: Pending, ver: number | null) => {
    setBusy(true)
    setFailure(null)
    setServerErrors({})
    try {
      if (pending.kind === 'delete') {
        if (!target.rowId || ver === null) return
        if (suggest) {
          await editApi.submit(layer.id, {
            op: 'delete',
            rowId: target.rowId,
            ver,
            ...(note.trim() ? { note: note.trim() } : {}),
          })
          afterSubmit()
          return
        }
        await editApi.remove(layer.id, target.rowId, ver)
        toast.show({ title: t('gis.edit.removed'), tone: 'success' })
        useSession.getState().controller?.clear()
        useSession.getState().discard()
        studio.setSelection([])
        refreshAfterWrite(client, layer)
        return
      }
      const geometryChanged = pending.geometry !== null
      if (!target.rowId) {
        if (!pending.geometry) {
          setFailure(t('gis.edit.drawFirst'))
          return
        }
        if (suggest) {
          await editApi.submit(layer.id, {
            op: 'create',
            values: pending.values,
            geometry: pending.geometry,
            ...(note.trim() ? { note: note.trim() } : {}),
          } as FeatureEditInput)
          afterSubmit()
          return
        }
        const created = await editApi.create(layer.id, pending.values, pending.geometry)
        toast.show({ title: t('gis.edit.created'), tone: 'success' })
        finish(created, values)
        return
      }
      if (ver === null) return
      if (suggest) {
        await editApi.submit(layer.id, {
          op: 'update',
          rowId: target.rowId,
          ver,
          values: pending.values,
          ...(geometryChanged && pending.geometry ? { geometry: pending.geometry } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        })
        afterSubmit()
        return
      }
      const updated = await editApi.update(layer.id, target.rowId, {
        values: pending.values,
        ...(geometryChanged && pending.geometry ? { geometry: pending.geometry } : {}),
        ver,
      })
      toast.show({ title: t('gis.edit.saved'), tone: 'success' })
      finish(updated, values)
    } catch (error) {
      fail(error, pending)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (checked: Record<string, unknown>) => {
    const changedGeometry =
      geometry && !target.geometryLocked && !sameGeometry(geometry, target.original)
        ? geometry
        : null
    if (!target.rowId) {
      const filled = Object.fromEntries(
        Object.entries(checked).filter(([, value]) => !isEmpty(value)),
      )
      await run({ kind: 'save', values: filled, geometry }, null)
      return
    }
    const changed = Object.fromEntries(
      Object.entries(checked).filter(([key, value]) => !same(value, target.values[key])),
    )
    if (Object.keys(changed).length === 0 && !changedGeometry) {
      toast.show({ title: t('gis.edit.nothingChanged'), tone: 'info' })
      return
    }
    await run({ kind: 'save', values: changed, geometry: changedGeometry }, target.ver)
  }

  /** Отменить свою правку после конфликта: объект — в текущем состоянии с сервера. */
  const reload = async () => {
    setConflict(null)
    if (!target.rowId) return
    try {
      const feature = await editApi.feature(layer.id, target.rowId)
      const current = feature.geometry as FeatureGeometry | null
      useSession.getState().open(
        {
          rowId: feature.id,
          ver: feature.ver,
          values: feature.values,
          original: current,
          geometryLocked: target.geometryLocked,
        },
        current,
        feature.values,
      )
      if (current && !target.geometryLocked) {
        useSession.getState().controller?.load(splitParts(current))
      }
      refreshAfterWrite(client, layer)
    } catch {
      useSession.getState().controller?.clear()
      useSession.getState().discard()
    }
  }

  const cancel = () => {
    useSession.getState().controller?.clear()
    useSession.getState().discard()
    studio.setSelection([])
  }

  const renderControl = (control: ControlProps) => {
    const { field } = control
    if (field.type === 'territory') {
      return (
        <TerritoryField
          id={control.id}
          value={control.value}
          invalid={control.invalid}
          disabled={control.disabled}
          suggestion={territoryField?.key === field.key ? suggestion : null}
          auto={territoryField?.key === field.key && autoTerritory}
          onChange={(value) => control.onChange(value)}
        />
      )
    }
    // Справочник: подпись вместо ключа, выбор из строк справочника (ADR-0057)
    const options = field.lookup ? fieldOptions.get(field.key) : undefined
    if (options?.length) {
      return (
        <Select
          value={isEmpty(control.value) ? '' : String(control.value)}
          onValueChange={(next) => control.onChange(next)}
          disabled={control.disabled}
        >
          <SelectTrigger id={control.id} invalid={control.invalid}>
            <SelectValue placeholder={t('gis.edit.lookupPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label[locale] ?? option.label.ru}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    return undefined
  }

  const mine = conflict
    ? {
        ...(conflict.pending.kind === 'save' ? conflict.pending.values : {}),
        ...(conflict.pending.kind === 'save' && conflict.pending.geometry
          ? { [layer.geometryField]: conflict.pending.geometry }
          : {}),
      }
    : {}

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {target.rowId
            ? t('gis.edit.featureTitle', { id: target.rowId })
            : t('gis.edit.newFeature')}
        </h3>
        {target.ver !== null ? (
          <Badge size="sm">{t('gis.edit.version', { ver: target.ver })}</Badge>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon={<Undo2 className="size-3.5" />}
          onClick={cancel}
          disabled={busy}
        >
          {t('gis.edit.cancel')}
        </Button>
        {target.rowId ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setRemoving(true)}
            disabled={busy}
          >
            {t('gis.edit.remove')}
          </Button>
        ) : null}
      </div>
      {!geometry && !target.geometryLocked ? (
        <Callout tone="info">{t('gis.edit.drawHint')}</Callout>
      ) : null}
      {target.geometryLocked ? <Callout tone="info">{t('gis.edit.geometryLocked')}</Callout> : null}
      {suggest ? <Callout tone="warning">{t('gis.edit.moderatedHint')}</Callout> : null}
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {suggest ? (
        <Field label={t('gis.edit.note')} htmlFor={noteId}>
          <Textarea
            id={noteId}
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      ) : null}
      <SchemaForm
        schema={{ fields, columns: 1 }}
        values={values}
        onChange={(next) => {
          // Территорию, выбранную вручную, карта больше не подставляет
          const manual =
            territoryField && !same(next[territoryField.key], values[territoryField.key])
          setValues(next, manual ? false : undefined)
        }}
        onSubmit={submit}
        renderControl={renderControl}
        serverErrors={serverErrors}
        submitLabel={suggest ? t('gis.edit.submit') : t('gis.edit.save')}
      />
      {conflict ? (
        <ConflictDialog
          dataset={dataset}
          geometryField={layer.geometryField}
          mine={mine}
          conflict={conflict.conflict}
          busy={busy}
          overwriteLabel={
            conflict.pending.kind === 'delete'
              ? t('gis.edit.conflict.removeAnyway')
              : t('gis.edit.conflict.overwrite')
          }
          onOverwrite={() => {
            const next = conflict
            setConflict(null)
            void run(next.pending, next.conflict.current._ver)
          }}
          onDiscard={() => void reload()}
          onClose={() => setConflict(null)}
        />
      ) : null}
      <AlertDialog
        open={removing}
        onOpenChange={setRemoving}
        title={suggest ? t('gis.edit.removeSuggestTitle') : t('gis.edit.removeTitle')}
        description={t('gis.edit.removeBody')}
        confirmLabel={suggest ? t('gis.edit.submit') : t('common.actions.delete')}
        destructive={!suggest}
        loading={busy}
        onConfirm={() => {
          setRemoving(false)
          void run({ kind: 'delete' }, target.ver)
        }}
      />
    </div>
  )
}
