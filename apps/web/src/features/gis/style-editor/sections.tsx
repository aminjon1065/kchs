import { type LayerStyle, layerTemplateFields } from '@kchs/contracts'
import { fieldsFor, resolveColor } from '@kchs/map-style'
import {
  Checkbox,
  FilterBuilder,
  Input,
  MapColorPicker,
  MapIconPicker,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { useT } from '~/app/i18n.js'
import { fieldLabel, filterFieldsOf } from '../../data/field-types.js'
import { useTerritoryFilterEditor } from '../territory-filter.js'
import {
  ChoiceSelect,
  EditorRow,
  EditorSection,
  FieldPicker,
  NumberField,
  useStyleEditor,
} from './controls.js'
import {
  appendTemplateField,
  LINE_DASHES,
  type LineDash,
  lineDashOf,
  withLangText,
} from './model.js'
import { SizeRange } from './renderer-section.js'

type Patch<K extends keyof LayerStyle> = (value: LayerStyle[K]) => LayerStyle[K]

/** Правка одной части стиля — по последней версии рабочей копии. */
function usePart<K extends keyof LayerStyle>(key: K) {
  const { update } = useStyleEditor()
  return (change: Patch<K>) => update((style) => ({ ...style, [key]: change(style[key]) }))
}

const POINT_SHAPES = ['circle', 'square', 'triangle', 'icon'] as const
const LINE_CAPS = ['round', 'butt', 'square'] as const
const PRIORITIES = ['none', 'size', 'field'] as const
const PLACEMENTS = ['auto', 'point', 'line'] as const
const TIME_MODES = ['range', 'instant', 'cumulative'] as const
const TIME_STEPS = ['hour', 'day', 'week', 'month', 'year'] as const
const POPUP_ACTIONS = ['open', 'documents', 'instruction'] as const
const POPUP_FIELDS = 20
const NONE = '__none__'

/** Точки, линии или полигоны: форма, размер, толщина, пунктир, заливка, обводка. */
export function GeometrySection() {
  const t = useT()
  const { style } = useStyleEditor()
  switch (style.geometry) {
    case 'point':
      return (
        <EditorSection title={t('gis.style.sections.point')} paths={['point']}>
          <PointForm />
        </EditorSection>
      )
    case 'line':
      return (
        <EditorSection title={t('gis.style.sections.line')} paths={['line']}>
          <LineForm />
        </EditorSection>
      )
    case 'polygon':
      return (
        <EditorSection title={t('gis.style.sections.polygon')} paths={['polygon']}>
          <PolygonForm />
        </EditorSection>
      )
  }
}

function PointForm() {
  const t = useT()
  const { style, theme, fields } = useStyleEditor()
  const set = usePart('point')
  const point = style.point
  const color =
    theme && style.renderer.kind === 'simple'
      ? resolveColor(style.renderer.color, theme).color
      : '#6B7280'
  return (
    <>
      <EditorRow label={t('gis.style.point.shape')} id="style-point-shape">
        <SegmentedControl
          size="sm"
          aria-label={t('gis.style.point.shape')}
          value={point.shape}
          onValueChange={(shape) => set((current) => ({ ...current, shape }))}
          options={POINT_SHAPES.map((shape) => ({
            value: shape,
            label: t(`gis.style.point.shapes.${shape}`),
          }))}
        />
      </EditorRow>
      {point.shape === 'icon' ? (
        <EditorRow label={t('gis.style.icon')} id="style-point-icon">
          <MapIconPicker
            id="style-point-icon"
            value={point.icon}
            color={color}
            aria-label={t('gis.style.icon')}
            onChange={(icon) => set((current) => ({ ...current, icon }))}
          />
        </EditorRow>
      ) : null}
      <EditorRow label={t('gis.style.point.size')} id="style-point-size">
        <NumberField
          id="style-point-size"
          value={point.size}
          min={1}
          max={64}
          suffix={t('gis.style.px')}
          onChange={(size) => size !== null && set((current) => ({ ...current, size }))}
        />
      </EditorRow>
      <Switch
        checked={point.sizeBy !== null}
        label={t('gis.style.point.sizeBy')}
        onCheckedChange={(checked) => {
          const field = fieldsFor(fields, 'number')[0]?.key
          set((current) => ({
            ...current,
            sizeBy: checked && field ? { field, min: 4, max: 24, scale: 'sqrt' as const } : null,
          }))
        }}
      />
      {point.sizeBy ? (
        <>
          <EditorRow
            label={t('gis.style.field.label')}
            id="style-point-sizeby"
            path="point.sizeBy.field"
          >
            <FieldPicker
              id="style-point-sizeby"
              fieldRole="number"
              value={point.sizeBy.field}
              onChange={(key) =>
                key &&
                set((current) => ({
                  ...current,
                  sizeBy: current.sizeBy ? { ...current.sizeBy, field: key } : null,
                }))
              }
            />
          </EditorRow>
          <SizeRange
            idPrefix="style-point-sizeby"
            min={point.sizeBy.min}
            max={point.sizeBy.max}
            scale={point.sizeBy.scale}
            onChange={(patch) =>
              set((current) => ({
                ...current,
                sizeBy: current.sizeBy ? { ...current.sizeBy, ...patch } : null,
              }))
            }
          />
        </>
      ) : null}
    </>
  )
}

function LineForm() {
  const t = useT()
  const { style } = useStyleEditor()
  const set = usePart('line')
  const line = style.line
  const dash = lineDashOf(line.dash)
  return (
    <>
      <EditorRow label={t('gis.style.line.width')} id="style-line-width">
        <NumberField
          id="style-line-width"
          value={line.width}
          min={0.5}
          max={20}
          step={0.5}
          suffix={t('gis.style.px')}
          onChange={(width) => width !== null && set((current) => ({ ...current, width }))}
        />
      </EditorRow>
      <div className="grid grid-cols-2 gap-2">
        <EditorRow label={t('gis.style.line.dash')} id="style-line-dash">
          <ChoiceSelect
            id="style-line-dash"
            value={dash === 'custom' ? 'dash' : dash}
            choices={Object.keys(LINE_DASHES) as LineDash[]}
            label={(value) => t(`gis.style.line.dashes.${value}`)}
            onChange={(value) =>
              set((current) => ({
                ...current,
                dash: LINE_DASHES[value] ? [...(LINE_DASHES[value] as readonly number[])] : null,
              }))
            }
          />
        </EditorRow>
        <EditorRow label={t('gis.style.line.cap')} id="style-line-cap">
          <ChoiceSelect
            id="style-line-cap"
            value={line.cap}
            choices={LINE_CAPS}
            label={(value) => t(`gis.style.line.caps.${value}`)}
            onChange={(cap) => set((current) => ({ ...current, cap }))}
          />
        </EditorRow>
      </div>
    </>
  )
}

function PolygonForm() {
  const t = useT()
  const { style, theme } = useStyleEditor()
  const set = usePart('polygon')
  const polygon = style.polygon
  return (
    <>
      <EditorRow label={t('gis.style.polygon.fillOpacity')} id="style-polygon-fill">
        <NumberField
          id="style-polygon-fill"
          value={polygon.fillOpacity}
          min={0}
          max={1}
          scale={100}
          step={5}
          suffix="%"
          onChange={(fillOpacity) =>
            fillOpacity !== null && set((current) => ({ ...current, fillOpacity }))
          }
        />
      </EditorRow>
      <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
        <EditorRow label={t('gis.style.polygon.outlineWidth')} id="style-polygon-outline-width">
          <NumberField
            id="style-polygon-outline-width"
            value={polygon.outline.width}
            min={0}
            max={10}
            step={0.5}
            suffix={t('gis.style.px')}
            onChange={(width) =>
              width !== null &&
              set((current) => ({ ...current, outline: { ...current.outline, width } }))
            }
          />
        </EditorRow>
        <EditorRow
          label={t('gis.style.polygon.outlineColor')}
          id="style-polygon-outline-color"
          path="polygon.outline.color"
        >
          <MapColorPicker
            id="style-polygon-outline-color"
            value={polygon.outline.color}
            theme={theme}
            allowAuto
            aria-label={t('gis.style.polygon.outlineColor')}
            onChange={(color) =>
              set((current) => ({ ...current, outline: { ...current.outline, color } }))
            }
          />
        </EditorRow>
      </div>
    </>
  )
}

/** Кластеры точек: на мелких масштабах сервер собирает близкие точки в скопления. */
export function ClusterSection() {
  const t = useT()
  const { style } = useStyleEditor()
  const set = usePart('cluster')
  if (style.geometry !== 'point') return null
  const cluster = style.cluster
  const enabled = cluster?.enabled === true
  return (
    <EditorSection title={t('gis.style.sections.cluster')} paths={['cluster']}>
      <Switch
        checked={enabled}
        label={t('gis.style.cluster.enabled')}
        onCheckedChange={(checked) =>
          set((current) => ({
            enabled: checked,
            radius: current?.radius ?? 40,
            maxZoom: current?.maxZoom ?? 11,
            style: current?.style ?? { sizeBy: 'point_count', min: 16, max: 48 },
          }))
        }
      />
      {cluster && enabled ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <EditorRow label={t('gis.style.cluster.radius')} id="style-cluster-radius">
              <NumberField
                id="style-cluster-radius"
                value={cluster.radius}
                min={10}
                max={200}
                suffix={t('gis.style.px')}
                onChange={(radius) =>
                  radius !== null &&
                  set((current) => (current ? { ...current, radius: Math.round(radius) } : current))
                }
              />
            </EditorRow>
            <EditorRow
              label={t('gis.style.cluster.maxZoom')}
              id="style-cluster-maxzoom"
              hint={t('gis.style.cluster.maxZoomHint')}
            >
              <NumberField
                id="style-cluster-maxzoom"
                value={cluster.maxZoom}
                min={0}
                max={22}
                onChange={(maxZoom) =>
                  maxZoom !== null &&
                  set((current) =>
                    current ? { ...current, maxZoom: Math.round(maxZoom) } : current,
                  )
                }
              />
            </EditorRow>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <EditorRow label={t('gis.style.cluster.min')} id="style-cluster-min">
              <NumberField
                id="style-cluster-min"
                value={cluster.style.min}
                min={8}
                max={cluster.style.max}
                suffix={t('gis.style.px')}
                onChange={(min) =>
                  min !== null &&
                  set((current) =>
                    current ? { ...current, style: { ...current.style, min } } : current,
                  )
                }
              />
            </EditorRow>
            <EditorRow label={t('gis.style.cluster.max')} id="style-cluster-max">
              <NumberField
                id="style-cluster-max"
                value={cluster.style.max}
                min={cluster.style.min}
                max={128}
                suffix={t('gis.style.px')}
                onChange={(max) =>
                  max !== null &&
                  set((current) =>
                    current ? { ...current, style: { ...current.style, max } } : current,
                  )
                }
              />
            </EditorRow>
          </div>
        </>
      ) : null}
    </EditorSection>
  )
}

/** Вставка поля в шаблон подписи или заголовка карточки. */
function InsertField({ id, onInsert }: { id: string; onInsert: (key: string) => void }) {
  const t = useT()
  const { fields, locale, layer } = useStyleEditor()
  return (
    <Select value={NONE} onValueChange={(key) => key !== NONE && onInsert(key)}>
      <SelectTrigger id={id} className="w-40 shrink-0" aria-label={t('gis.style.template.insert')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE} disabled>
          {t('gis.style.template.insert')}
        </SelectItem>
        {fieldsFor(fields, 'label')
          .filter((field) => field.key !== layer.geometryField)
          .map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {fieldLabel(field, locale)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

/** Подписи: поле или шаблон, размер, ореол, минимальный масштаб, приоритет. */
export function LabelSection() {
  const t = useT()
  const { style, fields, layer } = useStyleEditor()
  const set = usePart('label')
  const label = style.label
  const mode = label?.template !== null && label?.template !== undefined ? 'template' : 'field'
  const first = fieldsFor(fields, 'label').find((field) => field.key !== layer.geometryField)
  return (
    <EditorSection title={t('gis.style.sections.label')} paths={['label']}>
      <Switch
        checked={label !== null}
        label={t('gis.style.label.enabled')}
        onCheckedChange={(checked) =>
          set(() =>
            checked
              ? {
                  field: first?.key ?? null,
                  template: null,
                  size: 12,
                  halo: true,
                  minZoom: 9,
                  priority: 'none',
                  placement: 'auto',
                }
              : null,
          )
        }
      />
      {label ? (
        <>
          <SegmentedControl
            size="sm"
            aria-label={t('gis.style.label.mode')}
            value={mode}
            onValueChange={(next) =>
              set((current) =>
                current
                  ? next === 'template'
                    ? {
                        ...current,
                        template: current.field ? `{{${current.field}}}` : '',
                        field: null,
                      }
                    : {
                        ...current,
                        field: current.template
                          ? (layerTemplateFields(current.template)[0] ?? first?.key ?? null)
                          : (first?.key ?? null),
                        template: null,
                      }
                  : current,
              )
            }
            options={[
              { value: 'field', label: t('gis.style.label.modes.field') },
              { value: 'template', label: t('gis.style.label.modes.template') },
            ]}
          />
          {mode === 'field' ? (
            <EditorRow label={t('gis.style.field.label')} id="style-label-field" path="label.field">
              <FieldPicker
                id="style-label-field"
                fieldRole="label"
                value={label.field}
                onChange={(field) => set((current) => (current ? { ...current, field } : current))}
              />
            </EditorRow>
          ) : (
            <EditorRow
              label={t('gis.style.label.template')}
              id="style-label-template"
              path="label.template"
              hint={t('gis.style.template.hint')}
            >
              <div className="flex gap-1.5">
                <Input
                  id="style-label-template"
                  value={label.template ?? ''}
                  maxLength={200}
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    set((current) =>
                      current ? { ...current, template: event.target.value } : current,
                    )
                  }
                />
                <InsertField
                  id="style-label-insert"
                  onInsert={(key) =>
                    set((current) =>
                      current
                        ? { ...current, template: appendTemplateField(current.template ?? '', key) }
                        : current,
                    )
                  }
                />
              </div>
            </EditorRow>
          )}
          <div className="grid grid-cols-2 gap-2">
            <EditorRow label={t('gis.style.label.size')} id="style-label-size">
              <NumberField
                id="style-label-size"
                value={label.size}
                min={8}
                max={32}
                suffix={t('gis.style.px')}
                onChange={(size) =>
                  size !== null && set((current) => (current ? { ...current, size } : current))
                }
              />
            </EditorRow>
            <EditorRow
              label={t('gis.style.label.minZoom')}
              id="style-label-minzoom"
              hint={t('gis.style.label.minZoomHint')}
            >
              <NumberField
                id="style-label-minzoom"
                value={label.minZoom}
                min={0}
                max={22}
                onChange={(minZoom) =>
                  minZoom !== null &&
                  set((current) => (current ? { ...current, minZoom } : current))
                }
              />
            </EditorRow>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <EditorRow label={t('gis.style.label.priority')} id="style-label-priority">
              <ChoiceSelect
                id="style-label-priority"
                value={label.priority}
                choices={PRIORITIES}
                label={(value) => t(`gis.style.label.priorities.${value}`)}
                onChange={(priority) =>
                  set((current) => (current ? { ...current, priority } : current))
                }
              />
            </EditorRow>
            <EditorRow
              label={t('gis.style.label.placement')}
              id="style-label-placement"
              path="label.placement"
            >
              <ChoiceSelect
                id="style-label-placement"
                value={label.placement}
                choices={PLACEMENTS}
                label={(value) => t(`gis.style.label.placements.${value}`)}
                disabled={(value) => value === 'line' && style.geometry === 'point'}
                onChange={(placement) =>
                  set((current) => (current ? { ...current, placement } : current))
                }
              />
            </EditorRow>
          </div>
          <Switch
            checked={label.halo}
            label={t('gis.style.label.halo')}
            onCheckedChange={(halo) => set((current) => (current ? { ...current, halo } : current))}
          />
        </>
      ) : null}
    </EditorSection>
  )
}

/** Карточка объекта по щелчку: заголовок-шаблон, поля и действия. */
export function PopupSection() {
  const t = useT()
  const { style, fields, locale, layer } = useStyleEditor()
  const set = usePart('popup')
  const popup = style.popup
  const candidates = fields.filter(
    (field) => field.key !== layer.geometryField && field.type !== 'geometry',
  )
  return (
    <EditorSection title={t('gis.style.sections.popup')} paths={['popup']}>
      <Switch
        checked={popup !== null}
        label={t('gis.style.popup.custom')}
        onCheckedChange={(checked) =>
          set(() =>
            checked
              ? {
                  title: candidates[0] ? `{{${candidates[0].key}}}` : '',
                  fields: candidates.slice(1, 5).map((field) => field.key),
                  actions: ['open'],
                }
              : null,
          )
        }
      />
      {popup ? (
        <>
          <EditorRow
            label={t('gis.style.popup.title')}
            id="style-popup-title"
            hint={t('gis.style.template.hint')}
          >
            <div className="flex gap-1.5">
              <Input
                id="style-popup-title"
                value={popup.title}
                maxLength={200}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  set((current) => (current ? { ...current, title: event.target.value } : current))
                }
              />
              <InsertField
                id="style-popup-insert"
                onInsert={(key) =>
                  set((current) =>
                    current
                      ? { ...current, title: appendTemplateField(current.title, key) }
                      : current,
                  )
                }
              />
            </div>
          </EditorRow>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg-secondary">
              {t('gis.style.popup.fields', { n: popup.fields.length, max: POPUP_FIELDS })}
            </legend>
            <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {candidates.map((field) => {
                const checked = popup.fields.includes(field.key)
                return (
                  <li key={field.key}>
                    <Checkbox
                      checked={checked}
                      disabled={!checked && popup.fields.length >= POPUP_FIELDS}
                      label={fieldLabel(field, locale)}
                      onCheckedChange={(next) =>
                        set((current) =>
                          current
                            ? {
                                ...current,
                                fields:
                                  next === true
                                    ? [...current.fields, field.key]
                                    : current.fields.filter((key) => key !== field.key),
                              }
                            : current,
                        )
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg-secondary">
              {t('gis.style.popup.actions')}
            </legend>
            {POPUP_ACTIONS.map((action) => (
              <Checkbox
                key={action}
                checked={popup.actions.includes(action)}
                label={t(`gis.style.popup.action.${action}`)}
                onCheckedChange={(next) =>
                  set((current) =>
                    current
                      ? {
                          ...current,
                          actions:
                            next === true
                              ? POPUP_ACTIONS.filter(
                                  (item) => item === action || current.actions.includes(item),
                                )
                              : current.actions.filter((item) => item !== action),
                        }
                      : current,
                  )
                }
              />
            ))}
          </fieldset>
        </>
      ) : (
        <p className="text-xs text-fg-muted">{t('gis.style.popup.auto')}</p>
      )}
    </EditorSection>
  )
}

/** Прозрачность и масштабы, на которых слой виден. */
export function VisibilitySection() {
  const t = useT()
  const { style, update } = useStyleEditor()
  return (
    <EditorSection
      title={t('gis.style.sections.visibility')}
      paths={['opacity', 'minZoom', 'maxZoom']}
    >
      <EditorRow label={t('gis.style.visibility.opacity')} id="style-opacity">
        <NumberField
          id="style-opacity"
          value={style.opacity}
          min={0}
          max={1}
          scale={100}
          step={5}
          suffix="%"
          onChange={(opacity) => opacity !== null && update((current) => ({ ...current, opacity }))}
        />
      </EditorRow>
      <div className="grid grid-cols-2 gap-2">
        <EditorRow label={t('gis.style.visibility.minZoom')} id="style-minzoom">
          <NumberField
            id="style-minzoom"
            value={style.minZoom}
            min={0}
            max={style.maxZoom}
            onChange={(minZoom) =>
              minZoom !== null && update((current) => ({ ...current, minZoom }))
            }
          />
        </EditorRow>
        <EditorRow label={t('gis.style.visibility.maxZoom')} id="style-maxzoom">
          <NumberField
            id="style-maxzoom"
            value={style.maxZoom}
            min={style.minZoom}
            max={24}
            onChange={(maxZoom) =>
              maxZoom !== null && update((current) => ({ ...current, maxZoom }))
            }
          />
        </EditorRow>
      </div>
      <p className="text-xs text-fg-muted">{t('gis.style.visibility.zoomHint')}</p>
    </EditorSection>
  )
}

/** Фильтр слоя: какие строки датасета показывает слой (поверх политик строк). */
export function FilterSection() {
  const t = useT()
  const { style, update, fields, options, locale, layer } = useStyleEditor()
  const territoryEditor = useTerritoryFilterEditor(
    fields.some((field) => field.type === 'territory'),
  )
  const filterFields = filterFieldsOf(
    fields.filter((field) => field.key !== layer.geometryField),
    locale,
    options,
  )
  return (
    <EditorSection title={t('gis.style.sections.filter')} paths={['filter']}>
      <p className="text-xs text-fg-muted">{t('gis.style.filter.hint')}</p>
      <FilterBuilder
        fields={filterFields}
        value={style.filter}
        renderValue={territoryEditor}
        onChange={(filter) => update((current) => ({ ...current, filter }))}
      />
    </EditorSection>
  )
}

/** Время на карте: поле даты, режим и шаг слайдера. */
export function TimeSection() {
  const t = useT()
  const { style, fields } = useStyleEditor()
  const set = usePart('time')
  const time = style.time
  const temporal = fieldsFor(fields, 'time')
  if (temporal.length === 0 && !time) return null
  return (
    <EditorSection title={t('gis.style.sections.time')} paths={['time']}>
      <Switch
        checked={time !== null}
        disabled={temporal.length === 0}
        label={t('gis.style.time.enabled')}
        onCheckedChange={(checked) =>
          set(() =>
            checked && temporal[0] ? { field: temporal[0].key, mode: 'range', step: 'day' } : null,
          )
        }
      />
      {time ? (
        <>
          <EditorRow label={t('gis.style.field.label')} id="style-time-field" path="time.field">
            <FieldPicker
              id="style-time-field"
              fieldRole="time"
              value={time.field}
              onChange={(field) =>
                field && set((current) => (current ? { ...current, field } : current))
              }
            />
          </EditorRow>
          <div className="grid grid-cols-2 gap-2">
            <EditorRow label={t('gis.style.time.mode')} id="style-time-mode">
              <ChoiceSelect
                id="style-time-mode"
                value={time.mode}
                choices={TIME_MODES}
                label={(value) => t(`gis.style.time.modes.${value}`)}
                onChange={(mode) => set((current) => (current ? { ...current, mode } : current))}
              />
            </EditorRow>
            <EditorRow label={t('gis.style.time.step')} id="style-time-step">
              <ChoiceSelect
                id="style-time-step"
                value={time.step}
                choices={TIME_STEPS}
                label={(value) => t(`gis.style.time.steps.${value}`)}
                onChange={(step) => set((current) => (current ? { ...current, step } : current))}
              />
            </EditorRow>
          </div>
        </>
      ) : null}
    </EditorSection>
  )
}

/** Легенда: показывать ли и заголовок (по умолчанию — подпись поля). */
export function LegendSection() {
  const t = useT()
  const { style, locale } = useStyleEditor()
  const set = usePart('legend')
  const legend = style.legend
  return (
    <EditorSection title={t('gis.style.sections.legend')} paths={['legend']}>
      <Switch
        checked={legend.show}
        label={t('gis.style.legend.show')}
        onCheckedChange={(show) => set((current) => ({ ...current, show }))}
      />
      <EditorRow label={t('gis.style.legend.title')} id="style-legend-title">
        <Input
          id="style-legend-title"
          value={legend.title ? (legend.title[locale] ?? legend.title.ru) : ''}
          placeholder={t('gis.style.legend.titleAuto')}
          maxLength={200}
          onChange={(event) =>
            set((current) => ({
              ...current,
              title: withLangText(current.title, locale, event.target.value),
            }))
          }
        />
      </EditorRow>
    </EditorSection>
  )
}
