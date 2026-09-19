import type { DatasetField, FieldOption, LayerStyle } from '@kchs/contracts'
import {
  applyStylePreset,
  type CategoryValue,
  type StylePreset,
  stylePresets,
} from '@kchs/map-style'
import { Button } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { categoriesWithLabels, loadCategoryValues } from './categories.js'
import { EditorSection, useFieldName, useStyleEditor } from './controls.js'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Подпись пресета: вид и поле («По категориям: Вид»). */
export function presetLabel(
  t: Translate,
  fieldName: (key: string) => string,
  preset: StylePreset,
): string {
  return preset.field
    ? t(`gis.style.presets.${preset.kind}Field`, { field: fieldName(preset.field) })
    : t(`gis.style.presets.${preset.kind}`)
}

/**
 * Стиль по пресету с категориями из значений поля: у справочников и территорий
 * категории получают подписи (в легенде — название, а не ключ).
 */
export function styleWithPreset(
  style: LayerStyle,
  preset: StylePreset,
  fields: readonly DatasetField[],
  options: ReadonlyMap<string, readonly FieldOption[]>,
  values: readonly CategoryValue[] | null,
): LayerStyle {
  const next = applyStylePreset(style, preset, { fields, categories: values })
  if (!values || next.renderer.kind !== 'categorized' || !preset.field) return next
  const field = preset.field
  return {
    ...next,
    renderer: {
      ...next.renderer,
      categories: categoriesWithLabels(
        values,
        fields.find((item) => item.key === field),
        options.get(field),
      ),
    },
  }
}

/** Стиль уже соответствует пресету: тот же вид рендерера и поле (или время по полю). */
export function presetActive(style: LayerStyle, preset: StylePreset): boolean {
  if (preset.kind === 'time') return style.time?.field === preset.field
  if (style.renderer.kind !== preset.kind) return false
  const renderer = style.renderer
  if (renderer.kind === 'heatmap') return renderer.weightField === preset.field
  return 'field' in renderer ? renderer.field === preset.field : preset.field === null
}

/**
 * «Умные» пресеты по семантике полей датасета (07-gis-engine.md §4): категория
 * → по категориям (значения — запросом с политиками), мера → классы или размер,
 * время → время на карте. Пресет меняет рабочую копию — дальше правится вручную.
 */
export function PresetsSection() {
  const t = useT()
  const { style, update, fields, options, layer } = useStyleEditor()
  const fieldName = useFieldName()
  const presets = stylePresets(
    fields.filter((field) => field.key !== layer.geometryField),
    style.geometry,
  )
  const apply = useMutation({
    mutationFn: async (preset: StylePreset) =>
      preset.kind === 'categorized' && preset.field
        ? loadCategoryValues(layer.datasetId, preset.field, style.filter)
        : null,
    onSuccess: (values, preset) =>
      update((current) => styleWithPreset(current, preset, fields, options, values)),
  })
  return (
    <EditorSection title={t('gis.style.sections.presets')} paths={[]} defaultOpen>
      <p className="text-xs text-fg-muted">{t('gis.style.presets.hint')}</p>
      <fieldset className="flex flex-wrap gap-1.5" aria-label={t('gis.style.sections.presets')}>
        {presets.map((preset) => {
          const active = presetActive(style, preset)
          return (
            <Button
              key={preset.id}
              size="sm"
              variant={active ? 'subtle' : 'secondary'}
              aria-pressed={active}
              icon={preset.kind === 'simple' ? undefined : <Sparkles className="size-3.5" />}
              loading={apply.isPending && apply.variables?.id === preset.id}
              onClick={() => apply.mutate(preset)}
            >
              {presetLabel(t, fieldName, preset)}
            </Button>
          )
        })}
      </fieldset>
      {apply.isError ? (
        <p role="alert" className="text-xs text-danger">
          {t('gis.style.categories.failed')}
        </p>
      ) : null}
    </EditorSection>
  )
}
