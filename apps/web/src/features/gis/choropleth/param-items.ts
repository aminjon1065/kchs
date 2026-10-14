import type { ChoroplethParams, DatasetRecord, Locale } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import type { KeyValueItem } from '@kchs/ui'
import type { useT } from '~/shared/i18n.js'

type Translate = ReturnType<typeof useT>

/** Параметры хороплета строками карточки анализа: связь, уровень, мера, нормализация, классы. */
export function choroplethParamItems(
  params: ChoroplethParams,
  dataset: DatasetRecord | undefined,
  t: Translate,
  locale: Locale,
): KeyValueItem[] {
  const labelOf = (key: string | null) => {
    const field = dataset?.fields.find((item) => item.key === key)
    return field ? (field.label[locale] ?? field.label.ru) : (key ?? '')
  }
  const measure = t(`gis.choropleth.measureNames.${params.measure.agg}`, {
    field: labelOf(params.measure.field),
  })
  const items: KeyValueItem[] = [
    {
      key: 'join',
      label: t('gis.choropleth.join'),
      value: t(`gis.choropleth.joinHints.${params.join}`, { field: labelOf(params.field) }),
    },
    {
      key: 'level',
      label: t('gis.choropleth.level'),
      value: t(`gis.choropleth.levels.${params.level}`),
    },
    { key: 'measure', label: t('gis.choropleth.measure'), value: measure },
    {
      key: 'normalize',
      label: t('gis.choropleth.normalize'),
      value:
        params.normalize === 'none'
          ? t('gis.choropleth.normalizations.none')
          : t(`gis.choropleth.per.${params.normalize}`, {
              n: formatNumber(params.per, {}, { locale }),
            }),
    },
    {
      key: 'style',
      label: t('gis.choropleth.method'),
      value: t('gis.choropleth.styleSummary', {
        method: t(`gis.choropleth.methods.${params.style.method}`),
        classes: params.style.classes,
        palette: t(`gis.choropleth.palettes.${params.style.palette.name}`),
      }),
    },
  ]
  return items
}
