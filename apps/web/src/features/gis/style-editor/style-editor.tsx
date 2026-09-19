import {
  type DatasetField,
  LAYER_GEOMETRIES,
  type LayerGeometry,
  type LayerRecord,
  LayerStyle,
  type Locale,
} from '@kchs/contracts'
import type { MapTheme, StyleWarning } from '@kchs/map-style'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  IconButton,
  SegmentedControl,
  Skeleton,
  useMapTheme,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { useFieldOptions } from '../../data/field-options.js'
import { datasetQuery } from '../../data/queries.js'
import { gisKeys } from '../queries.js'
import { EditorRow, type StyleEditorContextValue, StyleEditorProvider } from './controls.js'
import { styleDirty } from './model.js'
import { PresetsSection } from './presets-section.js'
import { RendererSection } from './renderer-section.js'
import {
  ClusterSection,
  FilterSection,
  GeometrySection,
  LabelSection,
  LegendSection,
  PopupSection,
  TimeSection,
  VisibilitySection,
} from './sections.js'

/**
 * Форма стиля слоя (07-gis-engine.md §4, контракт `layer-style.md`): пресеты по
 * семантике полей, рендерер, геометрия, кластеры, подписи, карточка объекта,
 * фильтр, время, видимость и легенда. Правит рабочую копию — карта
 * перерисовывается сразу; замечания компилятора — у своих полей.
 */
export function StyleEditor({
  layer,
  style,
  onChange,
  fields,
  warnings,
  theme,
}: {
  layer: LayerRecord
  style: LayerStyle
  onChange: (style: LayerStyle) => void
  fields: readonly DatasetField[]
  warnings: readonly StyleWarning[]
  theme: MapTheme | null
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const options = useFieldOptions(fields)
  // Последняя версия рабочей копии: правки подряд и после ожидания запроса не теряются
  const latest = useRef(style)
  latest.current = style
  const change = useRef(onChange)
  change.current = onChange
  const value = useMemo<StyleEditorContextValue>(
    () => ({
      layer,
      style,
      update: (apply) => {
        const next = apply(latest.current)
        latest.current = next
        change.current(next)
      },
      fields,
      options,
      theme,
      warnings,
      locale,
    }),
    [layer, style, fields, options, theme, warnings, locale],
  )
  return (
    <StyleEditorProvider value={value}>
      <div className="flex flex-col">
        {layer.geometryType === 'mixed' ? (
          <div className="border-b border-line px-1.5 py-3">
            <EditorRow label={t('gis.style.geometry')} id="style-geometry" path="geometry" exact>
              <SegmentedControl
                size="sm"
                aria-label={t('gis.style.geometry')}
                value={style.geometry}
                onValueChange={(geometry: LayerGeometry) =>
                  value.update((current) => ({ ...current, geometry }))
                }
                options={LAYER_GEOMETRIES.map((geometry) => ({
                  value: geometry,
                  label: t(`gis.layer.geometry.${geometry}`),
                }))}
              />
            </EditorRow>
          </div>
        ) : null}
        <PresetsSection />
        <RendererSection />
        <GeometrySection />
        <ClusterSection />
        <LabelSection />
        <PopupSection />
        <FilterSection />
        <TimeSection />
        <VisibilitySection />
        <LegendSection />
      </div>
    </StyleEditorProvider>
  )
}

/**
 * Панель стиля слоя — в карте-студии и на экране слоя (P2-E01 S03, ADR-0075):
 * рабочая копия стиля подменяет стиль слоя на карте до сохранения; «Сохранить» —
 * `PATCH /gis/layers/{id}` (право правки слоя), «Отменить» — вернуть сохранённый.
 * Рабочая копия живёт, пока открыта панель: закрытие с изменениями спрашивает.
 */
export function LayerStylePanel({
  layer,
  draft,
  onDraft,
  warnings,
  onClose,
}: {
  layer: LayerRecord
  /** Рабочая копия; null — правок нет, форма показывает сохранённый стиль. */
  draft: LayerStyle | null
  onDraft: (style: LayerStyle | null) => void
  /** Замечания компилятора к тому, что нарисовано (рабочей копии). */
  warnings: readonly StyleWarning[]
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const theme = useMapTheme(root)
  const [confirmClose, setConfirmClose] = useState(false)
  const { data: dataset } = useQuery(datasetQuery(layer.datasetId))
  const { data: object } = useQuery(objectQuery(layer.id))
  const canEdit = ['edit', 'manage', 'owner'].includes(object?.level ?? 'view')
  const style = draft ?? layer.style
  const dirty = styleDirty(layer.style, draft)

  // Панель закрыта или открыта для другого слоя — рабочая копия не остаётся на карте
  const discard = useRef(onDraft)
  discard.current = onDraft
  useEffect(() => () => discard.current(null), [])

  const save = useMutation({
    mutationFn: async () => {
      const parsed = LayerStyle.safeParse(style)
      if (!parsed.success) throw new Error('invalid-style')
      return http.patch<LayerRecord>(`/gis/layers/${layer.id}`, { style: parsed.data })
    },
    onSuccess: (record) => {
      client.setQueryData(gisKeys.layer(layer.id), record)
      void client.invalidateQueries({ queryKey: gisKeys.layer(layer.id) })
      void client.invalidateQueries({ queryKey: keys.object(layer.id) })
      onDraft(null)
      toast.show({ title: t('gis.style.saved'), tone: 'success' })
    },
    onError: (failure) =>
      toast.show({
        title:
          failure instanceof ApiError
            ? failure.message
            : failure instanceof Error && failure.message === 'invalid-style'
              ? t('gis.style.invalid')
              : t('errors.unknown'),
        tone: 'danger',
      }),
  })

  return (
    <section
      ref={setRoot}
      aria-label={t('gis.style.title', { name: layer.name })}
      className="flex h-full min-h-0 flex-col bg-surface"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-2">
        <Palette className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">{t('gis.style.heading')}</h2>
          <p className="truncate text-xs text-fg-muted">{layer.name}</p>
        </div>
        {dirty ? (
          <Badge size="sm" tone="accent">
            {t('gis.style.unsaved')}
          </Badge>
        ) : null}
        <IconButton
          label={t('common.actions.close')}
          size="sm"
          onClick={() => (dirty ? setConfirmClose(true) : onClose())}
        >
          <X className="size-4" aria-hidden />
        </IconButton>
      </header>
      {canEdit ? null : (
        <Callout tone="info" className="m-2">
          {t('gis.style.readOnly')}
        </Callout>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {dataset ? (
          <StyleEditor
            layer={layer}
            style={style}
            onChange={(next) => onDraft(next)}
            fields={dataset.fields}
            warnings={warnings}
            theme={theme}
          />
        ) : (
          <div className="flex flex-col gap-2 p-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
        <Button variant="secondary" size="sm" disabled={!dirty} onClick={() => onDraft(null)}>
          {t('gis.style.revert')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || !canEdit}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('gis.style.save')}
        </Button>
      </footer>
      <AlertDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t('gis.style.discardTitle')}
        description={t('gis.style.discardHint')}
        confirmLabel={t('gis.style.discard')}
        onConfirm={() => {
          setConfirmClose(false)
          onDraft(null)
          onClose()
        }}
      />
    </section>
  )
}
