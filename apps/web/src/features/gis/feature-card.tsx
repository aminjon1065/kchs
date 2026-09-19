import { type DatasetRecord, type LayerRecord, layerTemplateFields } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { Button, Callout, IconButton, KeyValueList, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Table2, X } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError } from '~/shared/api/client.js'
import { datasetQuery } from '../data/queries.js'
import { layerFeatureQuery } from './queries.js'

/** Полей в карточке без настроенной карточки слоя: заголовок и ещё четыре. */
const DEFAULT_FIELDS = 5

/** Шаблон заголовка карточки `{{name}} ({{kind}})` → текст значений строки. */
function fillTemplate(template: string, text: (key: string) => string): string {
  return template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (_match, key: string) => text(key))
}

/**
 * Карточка объекта по щелчку (03-screens.md §10): заголовок и 3–5 полей из
 * настройки карточки слоя, иначе — первые поля датасета; значения — строка с
 * политиками смотрящего (`/features/{rowId}`), форматы — как в таблице.
 */
export function FeatureCard({
  layer,
  rowId,
  onClose,
}: {
  layer: LayerRecord
  rowId: string
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const feature = useQuery(layerFeatureQuery(layer.id, rowId))
  const { data: dataset } = useQuery(datasetQuery(layer.datasetId))

  const fieldOf = (key: string) => dataset?.fields.find((field) => field.key === key)
  const text = (key: string): string => {
    const value = feature.data?.values[key]
    const field = fieldOf(key)
    if (value === null || value === undefined || value === '') return '—'
    if (!field) return String(value)
    return (
      formatValue(
        value,
        {
          type: field.type,
          format: field.format ?? undefined,
          options: field.options ?? undefined,
        },
        { locale },
      ) || '—'
    )
  }
  const label = (key: string) => {
    const field = fieldOf(key)
    return field ? (field.label[locale] ?? field.label.ru ?? key) : key
  }

  const popup = layer.style.popup
  const shown = popup?.fields.length
    ? popup.fields
    : visibleKeys(dataset, layer.geometryField).slice(0, DEFAULT_FIELDS)
  const titleKey = popup?.title ? null : shown[0]
  const title = popup?.title
    ? fillTemplate(popup.title, text)
    : titleKey
      ? text(titleKey)
      : layer.name
  const rest = popup?.fields.length ? shown : shown.slice(1)
  const templateOnly = popup?.title ? layerTemplateFields(popup.title) : []

  return (
    <div className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-md">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-fg-muted">{layer.name}</p>
          {feature.isLoading ? (
            <Skeleton className="mt-1 h-5 w-40" />
          ) : (
            <p className="truncate text-sm font-semibold text-fg" title={title}>
              {title}
            </p>
          )}
        </div>
        <IconButton label={t('common.actions.close')} size="sm" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </IconButton>
      </div>
      {feature.error ? (
        <Callout
          tone={
            feature.error instanceof ApiError && feature.error.status === 404 ? 'info' : 'danger'
          }
        >
          {feature.error instanceof ApiError && feature.error.status === 404
            ? t('gis.feature.notVisible')
            : t('gis.feature.failed')}
        </Callout>
      ) : feature.isLoading ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : (
        <KeyValueList
          items={rest
            .filter((key) => !templateOnly.includes(key) || rest.length <= 1)
            .map((key) => ({ key, label: label(key), value: text(key) }))}
        />
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          icon={<Table2 className="size-3.5" />}
          onClick={() =>
            openTab({
              kind: 'object',
              objectId: layer.datasetId,
              objectType: 'dataset',
              title: dataset?.name ?? layer.name,
              mode: 'permanent',
            })
          }
        >
          {t('gis.feature.openDataset')}
        </Button>
      </div>
    </div>
  )
}

function visibleKeys(dataset: DatasetRecord | undefined, geometryField: string): string[] {
  return (dataset?.fields ?? [])
    .filter((field) => field.key !== geometryField && field.type !== 'geometry')
    .map((field) => field.key)
}
