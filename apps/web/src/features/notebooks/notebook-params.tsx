import type { DatasetField, NotebookBindings, NotebookParams } from '@kchs/contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { PERIOD_PRESETS, type PeriodPreset, periodValue } from '~/features/data/dashboard-layout.js'
import { labelOf } from '~/features/data/explore-builder.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { useNotebook } from './notebook-context.js'
import { paramsOf } from './notebook-doc.js'

const CUSTOM = '__custom'
const AUTO = '__auto'
const OFF = '__off'

/** Предустановка периода по значению; интервал дат из API — «свой период». */
function presetOf(period: NotebookParams['period']): PeriodPreset | typeof CUSTOM {
  const match = PERIOD_PRESETS.find(
    (preset) => JSON.stringify(periodValue(preset)) === JSON.stringify(period ?? null),
  )
  return match ?? CUSTOM
}

/**
 * Параметры тетради (03-screens.md §9): период и территория над ячейками —
 * общие для всех соавторов и всех ячеек (ADR-0071).
 */
export function NotebookParamsBar() {
  const t = useT()
  const { doc, params, readOnly } = useNotebook()
  const preset = presetOf(params.period)
  const set = (key: keyof NotebookParams, value: unknown) =>
    doc.transact(() => paramsOf(doc).set(key, value))
  const range = params.period && !('unit' in params.period) ? params.period : null

  return (
    <fieldset
      disabled={readOnly}
      className="m-0 flex shrink-0 flex-wrap items-center gap-3 border-0 border-b border-line bg-surface-2 px-4 py-2"
    >
      <legend className="sr-only">{t('data.notebook.params.label')}</legend>
      <span aria-hidden className="text-2xs font-medium tracking-wide text-fg-muted uppercase">
        {t('data.notebook.params.label')}
      </span>
      <Select
        value={preset}
        onValueChange={(next) => {
          if (next !== CUSTOM) set('period', periodValue(next as PeriodPreset))
        }}
      >
        <SelectTrigger aria-label={t('data.notebook.params.period')} className="h-7 w-44 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_PRESETS.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`data.dashboard.periods.${item}`)}
            </SelectItem>
          ))}
          {range ? (
            <SelectItem value={CUSTOM}>
              {t('data.notebook.params.range', { from: range.from, to: range.to })}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <TerritorySelect
        value={params.territory}
        onChange={(value) => set('territory', value)}
        label={t('data.notebook.params.territory')}
      />
    </fieldset>
  )
}

/**
 * Привязка параметров в ячейке: к какому полю источника применяются период и
 * территория — автоматически, выбранное поле или не применять.
 */
export function BindingsControl({
  fields,
  bindings,
  onChange,
  disabled,
}: {
  fields: readonly DatasetField[]
  bindings: NotebookBindings
  onChange: (next: NotebookBindings) => void
  disabled?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const kinds = [
    { key: 'period' as const, types: new Set(['date', 'datetime']) },
    { key: 'territory' as const, types: new Set(['territory']) },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2">
      {kinds.map(({ key, types }) => {
        const candidates = fields.filter((field) => types.has(field.type))
        const bound = bindings[key]
        const value = bound === undefined ? AUTO : bound === null ? OFF : bound
        const option = (text: string) =>
          t('data.notebook.params.option', { param: t(`data.notebook.params.${key}`), value: text })
        return (
          <Select
            key={key}
            value={value}
            disabled={disabled}
            onValueChange={(next) => {
              const rest = { ...bindings }
              delete rest[key]
              onChange(next === AUTO ? rest : { ...rest, [key]: next === OFF ? null : next })
            }}
          >
            <SelectTrigger
              aria-label={t(`data.notebook.params.${key}Field`)}
              className="h-7 w-52 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{option(t('data.notebook.params.auto'))}</SelectItem>
              {candidates.map((field) => (
                <SelectItem key={field.key} value={field.key}>
                  {option(labelOf(field, locale))}
                </SelectItem>
              ))}
              <SelectItem value={OFF}>{option(t('data.notebook.params.off'))}</SelectItem>
            </SelectContent>
          </Select>
        )
      })}
    </div>
  )
}
