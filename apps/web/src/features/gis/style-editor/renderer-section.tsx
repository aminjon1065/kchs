import {
  CLASSIFICATION_METHODS,
  type ClassificationMethod,
  type LangText,
  type LayerStyle,
  STYLE_PALETTES,
  type StyleRenderer,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import { resolveColor, SEQUENTIAL_RAMPS } from '@kchs/map-style'
import {
  Button,
  FilterBuilder,
  IconButton,
  Input,
  MapColorPicker,
  MapIconPicker,
  MapPalettePicker,
  Switch,
} from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ListRestart, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { filterFieldsOf } from '../../data/field-types.js'
import { useLayerFieldStats } from '../layer-render.js'
import { useTerritoryFilterEditor } from '../territory-filter.js'
import { categoriesWithLabels, loadCategoryValues, typedCategoryValue } from './categories.js'
import {
  ChoiceSelect,
  EditorRow,
  EditorSection,
  FieldPicker,
  NumberField,
  useFieldName,
  useStyleEditor,
  WarningList,
} from './controls.js'
import {
  parseBreaks,
  RENDERER_KINDS,
  type RendererKind,
  statsRequests,
  warningsAt,
  withLangText,
  withRendererKind,
} from './model.js'

type Renderer<K extends RendererKind> = Extract<StyleRenderer, { kind: K }>

/** Правка рендерера нужного вида: если вид уже сменился, правка не применяется. */
function useRendererUpdate<K extends RendererKind>(kind: K) {
  const { update } = useStyleEditor()
  return (change: (renderer: Renderer<K>) => Renderer<K>) =>
    update((style) =>
      style.renderer.kind === kind
        ? { ...style, renderer: change(style.renderer as Renderer<K>) }
        : style,
    )
}

/**
 * Заполнение категорий значениями поля: запрос частот через компилятор с
 * политиками смотрящего, фильтр — рабочей копии; значения справочников и
 * территорий получают подписи.
 */
export function useCategoryFill() {
  const { layer, update, fields, options } = useStyleEditor()
  return useMutation({
    mutationFn: async ({ field, filter }: { field: string; filter: LayerStyle['filter'] }) =>
      loadCategoryValues(layer.datasetId, field, filter),
    onSuccess: (values, { field }) =>
      update((style) =>
        style.renderer.kind === 'categorized' && style.renderer.field === field
          ? {
              ...style,
              renderer: {
                ...style.renderer,
                categories: categoriesWithLabels(
                  values,
                  fields.find((item) => item.key === field),
                  options.get(field),
                ),
              },
            }
          : style,
      ),
  })
}

/** Рендерер: способ отображения и его настройки. */
export function RendererSection() {
  const t = useT()
  const { style, update, fields, layer, warnings } = useStyleEditor()
  const fill = useCategoryFill()
  const kind = style.renderer.kind
  const available = (next: RendererKind) =>
    next === kind || withRendererKind(style, next, fields) !== null

  return (
    <EditorSection
      title={t('gis.style.sections.renderer')}
      paths={['renderer', 'geometry']}
      defaultOpen
    >
      {/* Геометрия стиля не совпала с данными (у смешанных слоя — выбор выше) */}
      {layer.geometryType === 'mixed' ? null : (
        <WarningList warnings={warningsAt(warnings, 'geometry', { exact: true })} />
      )}
      <EditorRow
        label={t('gis.style.renderer.kind')}
        id="style-renderer-kind"
        path="renderer.kind"
        exact
      >
        <ChoiceSelect
          id="style-renderer-kind"
          value={kind}
          choices={RENDERER_KINDS}
          label={(value) => t(`gis.style.renderer.kinds.${value}`)}
          disabled={(value) => !available(value)}
          onChange={(next) => {
            const changed = withRendererKind(style, next, fields)
            if (!changed) return
            update(() => changed)
            // Категории без вариантов у поля — сразу значениями из данных
            if (
              changed.renderer.kind === 'categorized' &&
              changed.renderer.categories.length === 0
            ) {
              fill.mutate({ field: changed.renderer.field, filter: changed.filter })
            }
          }}
        />
      </EditorRow>
      {kind === 'simple' ? <SimpleForm /> : null}
      {kind === 'categorized' ? <CategorizedForm fill={fill} /> : null}
      {kind === 'graduated' ? <GraduatedForm /> : null}
      {kind === 'heatmap' ? <HeatmapForm /> : null}
      {kind === 'proportional' ? <ProportionalForm /> : null}
      {kind === 'rule' ? <RuleForm /> : null}
    </EditorSection>
  )
}

function SimpleForm() {
  const t = useT()
  const { style, theme } = useStyleEditor()
  const set = useRendererUpdate('simple')
  const renderer = style.renderer as Renderer<'simple'>
  const color = theme ? resolveColor(renderer.color, theme).color : '#888888'
  return (
    <>
      <EditorRow label={t('gis.style.color')} id="style-simple-color" path="renderer.color">
        <MapColorPicker
          id="style-simple-color"
          value={renderer.color}
          theme={theme}
          aria-label={t('gis.style.color')}
          onChange={(value) => set((current) => ({ ...current, color: value }))}
        />
      </EditorRow>
      {style.geometry === 'point' ? (
        <EditorRow label={t('gis.style.icon')} id="style-simple-icon">
          <MapIconPicker
            id="style-simple-icon"
            value={renderer.icon}
            color={color}
            aria-label={t('gis.style.icon')}
            onChange={(value) => set((current) => ({ ...current, icon: value }))}
          />
        </EditorRow>
      ) : null}
    </>
  )
}

function CategorizedForm({ fill }: { fill: ReturnType<typeof useCategoryFill> }) {
  const t = useT()
  const { style, theme, fields, options, locale, warnings } = useStyleEditor()
  const set = useRendererUpdate('categorized')
  const renderer = style.renderer as Renderer<'categorized'>
  const [adding, setAdding] = useState('')
  const field = fields.find((item) => item.key === renderer.field)
  const choices = options.get(renderer.field) ?? field?.options ?? []
  const pointLike = style.geometry !== 'polygon'
  const baseSize = style.geometry === 'line' ? style.line.width : style.point.size

  const valueLabel = (value: unknown, label?: LangText) => {
    if (label) return label[locale] ?? label.ru
    if (value === null) return t('gis.style.categories.empty')
    if (typeof value === 'boolean')
      return t(value ? 'gis.style.categories.yes' : 'gis.style.categories.no')
    const option = choices.find((item) => item.value === String(value))
    if (option) return option.label[locale] ?? option.label.ru
    if (typeof value === 'number') return formatNumber(value, field?.format ?? {}, { locale })
    return String(value)
  }
  const colorOf = (token: string) => (theme ? resolveColor(token, theme).color : '#888888')

  return (
    <>
      <EditorRow
        label={t('gis.style.field.label')}
        id="style-categorized-field"
        path="renderer.field"
      >
        <FieldPicker
          id="style-categorized-field"
          fieldRole="category"
          value={renderer.field}
          onChange={(key) => {
            if (!key) return
            set((current) => ({ ...current, field: key, categories: [] }))
            fill.mutate({ field: key, filter: style.filter })
          }}
        />
      </EditorRow>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg-secondary">
            {t('gis.style.categories.title', { n: renderer.categories.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={<ListRestart className="size-3.5" />}
            loading={fill.isPending}
            onClick={() => fill.mutate({ field: renderer.field, filter: style.filter })}
          >
            {t('gis.style.categories.fill')}
          </Button>
        </div>
        {fill.isError ? (
          <p role="alert" className="text-xs text-danger">
            {t('gis.style.categories.failed')}
          </p>
        ) : null}
        {renderer.categories.length === 0 && !fill.isPending ? (
          <p className="text-xs text-fg-muted">{t('gis.style.categories.none')}</p>
        ) : null}
        <ul className="flex flex-col gap-1" aria-label={t('gis.style.categories.list')}>
          {renderer.categories.map((category, index) => {
            const name = valueLabel(category.value, category.label)
            const path = `renderer.categories.${index}`
            return (
              <li
                key={`${JSON.stringify(category.value)}-${index}`}
                className="flex flex-col gap-0.5"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <MapColorPicker
                    compact
                    value={category.color}
                    theme={theme}
                    aria-label={t('gis.style.categories.color', { value: name })}
                    onChange={(value) =>
                      set((current) => ({
                        ...current,
                        categories: current.categories.map((item, i) =>
                          i === index ? { ...item, color: value } : item,
                        ),
                      }))
                    }
                  />
                  {style.geometry === 'point' ? (
                    <MapIconPicker
                      compact
                      value={category.icon ?? null}
                      color={colorOf(category.color)}
                      aria-label={t('gis.style.categories.icon', { value: name })}
                      onChange={(value) =>
                        set((current) => ({
                          ...current,
                          categories: current.categories.map((item, i) =>
                            i === index ? { ...item, icon: value } : item,
                          ),
                        }))
                      }
                    />
                  ) : null}
                  <Input
                    value={category.label ? (category.label[locale] ?? category.label.ru) : ''}
                    placeholder={name}
                    aria-label={t('gis.style.categories.label', { value: name })}
                    className="min-w-0 flex-1"
                    onChange={(event) =>
                      set((current) => ({
                        ...current,
                        categories: current.categories.map((item, i) => {
                          if (i !== index) return item
                          const label = withLangText(item.label, locale, event.target.value)
                          const { label: _previous, ...rest } = item
                          return label ? { ...rest, label } : rest
                        }),
                      }))
                    }
                  />
                  {pointLike ? (
                    <NumberField
                      value={category.size ?? null}
                      optional
                      min={1}
                      max={64}
                      placeholder={String(baseSize)}
                      aria-label={t('gis.style.categories.size', { value: name })}
                      className="w-14"
                      onChange={(value) =>
                        set((current) => ({
                          ...current,
                          categories: current.categories.map((item, i) => {
                            if (i !== index) return item
                            const { size: _previous, ...rest } = item
                            return value === null ? rest : { ...rest, size: value }
                          }),
                        }))
                      }
                    />
                  ) : null}
                  <IconButton
                    label={t('gis.style.categories.remove', { value: name })}
                    size="sm"
                    onClick={() =>
                      set((current) => ({
                        ...current,
                        categories: current.categories.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </div>
                <WarningList warnings={warningsAt(warnings, path)} />
              </li>
            )
          })}
        </ul>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            const value = typedCategoryValue(adding, field)
            set((current) => ({
              ...current,
              categories: [
                ...current.categories,
                { value, color: `categorical.${(current.categories.length % 8) + 1}` },
              ],
            }))
            setAdding('')
          }}
        >
          <Input
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            placeholder={t('gis.style.categories.addPlaceholder')}
            aria-label={t('gis.style.categories.addPlaceholder')}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="secondary" icon={<Plus className="size-3.5" />}>
            {t('gis.style.categories.add')}
          </Button>
        </form>
      </div>
      <OtherRow
        other={renderer.other}
        onChange={(other) => set((current) => ({ ...current, other }))}
      />
    </>
  )
}

/** «Прочее»: значения вне списка — своим цветом или не рисуются. */
function OtherRow({
  other,
  onChange,
}: {
  other: { color: string; label?: LangText } | null
  onChange: (other: { color: string; label?: LangText } | null) => void
}) {
  const t = useT()
  const { theme } = useStyleEditor()
  return (
    <div className="flex flex-col gap-1.5">
      <Switch
        checked={other !== null}
        onCheckedChange={(checked) => onChange(checked ? { color: 'other' } : null)}
        label={t('gis.style.other.show')}
      />
      {other ? (
        <EditorRow
          label={t('gis.style.other.color')}
          id="style-other-color"
          path="renderer.other.color"
        >
          <MapColorPicker
            id="style-other-color"
            value={other.color}
            theme={theme}
            aria-label={t('gis.style.other.color')}
            onChange={(color) => onChange({ ...other, color })}
          />
        </EditorRow>
      ) : (
        <p className="text-xs text-fg-muted">{t('gis.style.other.hidden')}</p>
      )}
    </div>
  )
}

const METHODS = CLASSIFICATION_METHODS
const CLASS_COUNTS = ['3', '4', '5', '6', '7', '8', '9'] as const

function GraduatedForm() {
  const t = useT()
  const { style, theme, layer, locale, warnings } = useStyleEditor()
  const set = useRendererUpdate('graduated')
  const renderer = style.renderer as Renderer<'graduated'>
  const stats = useLayerFieldStats(layer, statsRequests(style).breaks)
  const [breaksText, setBreaksText] = useState(() => (renderer.breaks ?? []).join('; '))
  const computed = stats.data?.breaks ?? null
  const polygon = style.geometry === 'polygon'

  return (
    <>
      <EditorRow
        label={t('gis.style.field.label')}
        id="style-graduated-field"
        path="renderer.field"
      >
        <FieldPicker
          id="style-graduated-field"
          fieldRole="number"
          value={renderer.field}
          onChange={(key) => key && set((current) => ({ ...current, field: key, breaks: null }))}
        />
      </EditorRow>
      <EditorRow
        label={t('gis.style.graduated.normalizeBy')}
        id="style-graduated-normalize"
        path="renderer.normalizeBy"
        hint={t('gis.style.graduated.normalizeHint')}
      >
        <FieldPicker
          id="style-graduated-normalize"
          fieldRole="number"
          allowNone
          exclude={[renderer.field]}
          value={renderer.normalizeBy}
          onChange={(key) => set((current) => ({ ...current, normalizeBy: key, breaks: null }))}
        />
      </EditorRow>
      <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
        <EditorRow label={t('gis.style.graduated.method')} id="style-graduated-method">
          <ChoiceSelect
            id="style-graduated-method"
            value={renderer.method}
            choices={METHODS}
            label={(value) => t(`gis.style.graduated.methods.${value}`)}
            onChange={(method: ClassificationMethod) => {
              // Ручные границы начинаются с рассчитанных
              if (method === 'manual' && computed) setBreaksText(computed.join('; '))
              set((current) => ({
                ...current,
                method,
                breaks: method === 'manual' ? (computed ?? current.breaks) : null,
              }))
            }}
          />
        </EditorRow>
        <EditorRow label={t('gis.style.graduated.classes')} id="style-graduated-classes">
          <ChoiceSelect
            id="style-graduated-classes"
            value={String(renderer.classes) as (typeof CLASS_COUNTS)[number]}
            choices={CLASS_COUNTS}
            label={(value) => value}
            onChange={(value) => set((current) => ({ ...current, classes: Number(value) }))}
          />
        </EditorRow>
      </div>
      {renderer.method === 'manual' ? (
        <EditorRow
          label={t('gis.style.graduated.breaks')}
          id="style-graduated-breaks"
          path="renderer.breaks"
          hint={t('gis.style.graduated.breaksHint')}
        >
          <Input
            id="style-graduated-breaks"
            value={breaksText}
            placeholder="0; 10; 50; 100"
            onChange={(event) => {
              setBreaksText(event.target.value)
              const breaks = parseBreaks(event.target.value)
              set((current) => ({ ...current, breaks: breaks.length ? breaks : null }))
            }}
          />
        </EditorRow>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-fg-muted" aria-live="polite">
            {stats.isFetching
              ? t('gis.style.graduated.computing')
              : stats.data
                ? stats.data.sample
                  ? t('gis.style.graduated.bySample', {
                      n: formatNumber(stats.data.sample, {}, { locale }),
                      total: formatNumber(stats.data.count, {}, { locale }),
                    })
                  : t('gis.style.graduated.byRows', {
                      n: formatNumber(stats.data.count, {}, { locale }),
                    })
                : stats.isError
                  ? t('gis.style.graduated.failed')
                  : null}
          </p>
          {/* Пока границы считаются, «ещё не рассчитаны» — не новость */}
          <WarningList
            warnings={warningsAt(warnings, 'renderer', { exact: true }).filter(
              (warning) => !(stats.isFetching && warning.code === 'breaks-missing'),
            )}
          />
        </div>
      )}
      <EditorRow label={t('gis.style.palette')} id="style-graduated-palette">
        <MapPalettePicker
          id="style-graduated-palette"
          value={renderer.palette}
          theme={theme}
          classes={renderer.classes}
          palettes={STYLE_PALETTES}
          onChange={(palette) => set((current) => ({ ...current, palette }))}
        />
      </EditorRow>
      <EditorRow
        label={t('gis.style.graduated.target')}
        id="style-graduated-target"
        path="renderer.visual.target"
      >
        <ChoiceSelect
          id="style-graduated-target"
          value={renderer.visual.target}
          choices={['fill', 'size', 'both'] as const}
          label={(value) => t(`gis.style.graduated.targets.${value}`)}
          disabled={(value) => polygon && value !== 'fill'}
          onChange={(target) => set((current) => ({ ...current, visual: { target } }))}
        />
      </EditorRow>
    </>
  )
}

function HeatmapForm() {
  const t = useT()
  const { style, theme } = useStyleEditor()
  const set = useRendererUpdate('heatmap')
  const renderer = style.renderer as Renderer<'heatmap'>
  return (
    <>
      <EditorRow
        label={t('gis.style.heatmap.weight')}
        id="style-heatmap-weight"
        path="renderer.weightField"
      >
        <FieldPicker
          id="style-heatmap-weight"
          fieldRole="number"
          allowNone
          noneLabel={t('gis.style.heatmap.noWeight')}
          value={renderer.weightField}
          onChange={(key) => set((current) => ({ ...current, weightField: key }))}
        />
      </EditorRow>
      <div className="grid grid-cols-2 gap-2">
        <EditorRow label={t('gis.style.heatmap.radius')} id="style-heatmap-radius">
          <NumberField
            id="style-heatmap-radius"
            value={renderer.radius}
            min={1}
            max={100}
            suffix={t('gis.style.px')}
            onChange={(value) =>
              value !== null && set((current) => ({ ...current, radius: value }))
            }
          />
        </EditorRow>
        <EditorRow label={t('gis.style.heatmap.intensity')} id="style-heatmap-intensity">
          <NumberField
            id="style-heatmap-intensity"
            value={renderer.intensity}
            min={0.1}
            max={5}
            step={0.1}
            onChange={(value) =>
              value !== null && set((current) => ({ ...current, intensity: value }))
            }
          />
        </EditorRow>
      </div>
      <EditorRow label={t('gis.style.palette')} id="style-heatmap-palette">
        <MapPalettePicker
          id="style-heatmap-palette"
          value={renderer.palette}
          theme={theme}
          classes={7}
          palettes={SEQUENTIAL_RAMPS}
          onChange={(palette) => set((current) => ({ ...current, palette }))}
        />
      </EditorRow>
    </>
  )
}

function ProportionalForm() {
  const t = useT()
  const { style, theme } = useStyleEditor()
  const set = useRendererUpdate('proportional')
  const renderer = style.renderer as Renderer<'proportional'>
  return (
    <>
      <EditorRow
        label={t('gis.style.field.label')}
        id="style-proportional-field"
        path="renderer.field"
      >
        <FieldPicker
          id="style-proportional-field"
          fieldRole="number"
          value={renderer.field}
          onChange={(key) => key && set((current) => ({ ...current, field: key }))}
        />
      </EditorRow>
      <SizeRange
        min={renderer.min}
        max={renderer.max}
        scale={renderer.scale}
        onChange={(patch) => set((current) => ({ ...current, ...patch }))}
      />
      <EditorRow label={t('gis.style.color')} id="style-proportional-color" path="renderer.color">
        <MapColorPicker
          id="style-proportional-color"
          value={renderer.color}
          theme={theme}
          aria-label={t('gis.style.color')}
          onChange={(color) => set((current) => ({ ...current, color }))}
        />
      </EditorRow>
    </>
  )
}

/** Размер по значению: наименьший и наибольший размер и шкала (у точек — диаметр, у линий — толщина). */
export function SizeRange({
  min,
  max,
  scale,
  onChange,
  idPrefix = 'style-size',
}: {
  min: number
  max: number
  scale: 'linear' | 'sqrt' | 'log'
  onChange: (patch: { min?: number; max?: number; scale?: 'linear' | 'sqrt' | 'log' }) => void
  idPrefix?: string
}) {
  const t = useT()
  return (
    <div className="grid grid-cols-3 gap-2">
      <EditorRow label={t('gis.style.size.min')} id={`${idPrefix}-min`}>
        <NumberField
          id={`${idPrefix}-min`}
          value={min}
          min={1}
          max={Math.min(64, max)}
          suffix={t('gis.style.px')}
          onChange={(value) => value !== null && onChange({ min: value })}
        />
      </EditorRow>
      <EditorRow label={t('gis.style.size.max')} id={`${idPrefix}-max`}>
        <NumberField
          id={`${idPrefix}-max`}
          value={max}
          min={Math.max(2, min)}
          max={96}
          suffix={t('gis.style.px')}
          onChange={(value) => value !== null && onChange({ max: value })}
        />
      </EditorRow>
      <EditorRow label={t('gis.style.size.scale')} id={`${idPrefix}-scale`}>
        <ChoiceSelect
          id={`${idPrefix}-scale`}
          value={scale}
          choices={['sqrt', 'linear', 'log'] as const}
          label={(value) => t(`gis.style.size.scales.${value}`)}
          onChange={(value) => onChange({ scale: value })}
        />
      </EditorRow>
    </div>
  )
}

function RuleForm() {
  const t = useT()
  const { style, theme, fields, options, locale, layer, warnings } = useStyleEditor()
  const set = useRendererUpdate('rule')
  const renderer = style.renderer as Renderer<'rule'>
  const fieldName = useFieldName()
  const filterFields = filterFieldsOf(
    fields.filter((field) => field.key !== layer.geometryField),
    locale,
    options,
  )
  const territoryEditor = useTerritoryFilterEditor(
    fields.some((field) => field.type === 'territory'),
  )
  const colorOf = (token: string) => (theme ? resolveColor(token, theme).color : '#888888')
  const move = (index: number, to: number) =>
    set((current) => {
      const rules = [...current.rules]
      const [moved] = rules.splice(index, 1)
      if (moved) rules.splice(to, 0, moved)
      return { ...current, rules }
    })

  return (
    <>
      <p className="text-xs text-fg-muted">{t('gis.style.rules.hint')}</p>
      <ol className="flex flex-col gap-2" aria-label={t('gis.style.rules.list')}>
        {renderer.rules.map((rule, index) => {
          const title = rule.label
            ? (rule.label[locale] ?? rule.label.ru)
            : t('gis.style.rules.rule', { n: index + 1 })
          return (
            <li
              // Правила без устойчивого ключа: порядок — сам приоритет
              key={index}
              className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-2"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <MapColorPicker
                  compact
                  value={rule.color}
                  theme={theme}
                  aria-label={t('gis.style.rules.color', { rule: title })}
                  onChange={(color) =>
                    set((current) => ({
                      ...current,
                      rules: current.rules.map((item, i) =>
                        i === index ? { ...item, color } : item,
                      ),
                    }))
                  }
                />
                {style.geometry === 'point' ? (
                  <MapIconPicker
                    compact
                    value={rule.icon ?? null}
                    color={colorOf(rule.color)}
                    aria-label={t('gis.style.rules.icon', { rule: title })}
                    onChange={(icon) =>
                      set((current) => ({
                        ...current,
                        rules: current.rules.map((item, i) =>
                          i === index ? { ...item, icon } : item,
                        ),
                      }))
                    }
                  />
                ) : null}
                <Input
                  value={rule.label ? (rule.label[locale] ?? rule.label.ru) : ''}
                  placeholder={t('gis.style.rules.rule', { n: index + 1 })}
                  aria-label={t('gis.style.rules.label', { n: index + 1 })}
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    set((current) => ({
                      ...current,
                      rules: current.rules.map((item, i) => {
                        if (i !== index) return item
                        const label = withLangText(item.label, locale, event.target.value)
                        const { label: _previous, ...rest } = item
                        return label ? { ...rest, label } : rest
                      }),
                    }))
                  }
                />
                <IconButton
                  label={t('gis.style.rules.up', { rule: title })}
                  size="sm"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </IconButton>
                <IconButton
                  label={t('gis.style.rules.down', { rule: title })}
                  size="sm"
                  disabled={index === renderer.rules.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </IconButton>
                <IconButton
                  label={t('gis.style.rules.remove', { rule: title })}
                  size="sm"
                  disabled={renderer.rules.length === 1}
                  onClick={() =>
                    set((current) => ({
                      ...current,
                      rules: current.rules.filter((_, i) => i !== index),
                    }))
                  }
                >
                  <X className="size-3.5" aria-hidden />
                </IconButton>
              </div>
              <FilterBuilder
                fields={filterFields}
                value={rule.filter}
                renderValue={territoryEditor}
                onChange={(filter) =>
                  filter &&
                  set((current) => ({
                    ...current,
                    rules: current.rules.map((item, i) =>
                      i === index ? { ...item, filter } : item,
                    ),
                  }))
                }
              />
              <WarningList warnings={warningsAt(warnings, `renderer.rules.${index}`)} />
            </li>
          )
        })}
      </ol>
      <Button
        size="sm"
        variant="secondary"
        icon={<Plus className="size-3.5" />}
        disabled={renderer.rules.length >= 50}
        className="self-start"
        onClick={() => {
          const first = filterFields[0]
          if (!first) return
          set((current) => ({
            ...current,
            rules: [
              ...current.rules,
              {
                filter: { field: first.key, op: 'not_empty' },
                color: `categorical.${(current.rules.length % 8) + 1}`,
              },
            ],
          }))
        }}
      >
        {t('gis.style.rules.add', { field: filterFields[0] ? fieldName(filterFields[0].key) : '' })}
      </Button>
      <OtherRow
        other={renderer.other}
        onChange={(other) => set((current) => ({ ...current, other }))}
      />
    </>
  )
}
