import { type DatasetRecord, type LayerRecord, layerTemplateFields } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { Button, Callout, IconButton, KeyValueList, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { FileText, Landmark, Table2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { territoriesQuery } from '~/entities/territory/queries.js'
import { useOpenPassport } from '~/entities/territory/territory-link.js'
import { useFieldOptions } from '~/features/data/index.js'
import { ApiError } from '~/shared/api/errors.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { layerDatasetQuery } from './layer-source-queries.js'
import { layerFeatureQuery } from './queries.js'

/** Полей в карточке без настроенной карточки слоя: заголовок и ещё четыре. */
const DEFAULT_FIELDS = 5
/** Ширина карточки (`w-72`) — по ней карточка у точки не выходит за правый край карты. */
const CARD_WIDTH = 288
/** Значение длиннее — строкой во всю ширину карточки, а не узким столбцом у подписи. */
const LONG_VALUE = 60
const NO_FIELDS: DatasetRecord['fields'] = []

/**
 * Карточка у точки щелчка: не выходит за края карты, высота — до нижнего края;
 * длинная карточка прокручивается внутри, а не обрезается краем карты.
 */
export function FeatureCardAt({
  point,
  offset = 8,
  children,
}: {
  point: readonly [number, number]
  offset?: number
  children: ReactNode
}) {
  const top = `clamp(${offset}px, ${point[1] + offset}px, calc(100% - 200px))`
  return (
    <div
      className="absolute z-20 flex flex-col"
      style={{
        left: `clamp(${offset}px, ${point[0] + offset}px, calc(100% - ${CARD_WIDTH + offset}px))`,
        top,
        maxHeight: `calc(100% - ${top} - ${offset}px)`,
      }}
    >
      {children}
    </div>
  )
}

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
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const feature = useQuery(layerFeatureQuery(layer.id, rowId))
  const { data: dataset } = useQuery(layerDatasetQuery(layer))
  const datasetId = layer.datasetId
  // Объект системного источника «Документы на карте» (ADR-0223) — документ: открывается он
  const documentId = layer.systemSource === 'document_places' ? feature.data?.values.id : undefined
  const openPassport = useOpenPassport()
  // Территория объекта (поле территории датасета) — переход в её паспорт
  const territoryField =
    dataset?.fields.find((field) => field.key === dataset.territoryField) ??
    dataset?.fields.find((field) => field.type === 'territory')
  const territoryId = territoryField ? feature.data?.values[territoryField.key] : null
  const { data: territories = [] } = useQuery({
    ...territoriesQuery(),
    enabled: typeof territoryId === 'string',
  })
  const territory = territories.find((item) => item.id === territoryId)
  // Территории и справочники — подписью, как в таблице датасета (ADR-0057), а не кодом
  const fieldOptions = useFieldOptions(dataset?.fields ?? NO_FIELDS)

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
          options: fieldOptions.get(key) ?? field.options ?? undefined,
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
  const items = rest
    .filter((key) => !templateOnly.includes(key) || rest.length <= 1)
    .map((key) => ({ key, label: label(key), value: text(key) }))
  const isLong = (item: { key: string; value: string }) =>
    fieldOf(item.key)?.type === 'long_text' || item.value.length > LONG_VALUE

  return (
    <div className="flex min-h-0 w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-md">
      <div className="flex min-w-0 shrink-0 items-start gap-2">
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
        <section
          aria-label={title}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: прокручиваемая область должна получать фокус (axe scrollable-region-focusable)
          tabIndex={0}
          className="-mx-3 flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3"
        >
          <KeyValueList items={items.filter((item) => !isLong(item))} />
          {items.filter(isLong).map((item) => (
            <div key={item.key} className="flex flex-col gap-0.5 text-sm">
              <p className="text-xs text-fg-muted">{item.label}</p>
              <p className="whitespace-pre-line break-words text-fg">{item.value}</p>
            </div>
          ))}
        </section>
      )}
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        {territory ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Landmark className="size-3.5" />}
            onClick={() => openPassport(territory)}
          >
            {t('gis.passport.open')}
          </Button>
        ) : null}
        {datasetId ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Table2 className="size-3.5" />}
            onClick={() =>
              openTab({
                kind: 'object',
                objectId: datasetId,
                objectType: 'dataset',
                title: dataset?.name ?? layer.name,
                mode: 'permanent',
              })
            }
          >
            {t('gis.feature.openDataset')}
          </Button>
        ) : typeof documentId === 'string' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<FileText className="size-3.5" />}
            onClick={() =>
              openTab({
                kind: 'object',
                objectId: documentId,
                objectType: 'document',
                title: text('subject'),
                mode: 'permanent',
              })
            }
          >
            {t('gis.feature.openDocument')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function visibleKeys(dataset: DatasetRecord | undefined, geometryField: string): string[] {
  return (dataset?.fields ?? [])
    .filter((field) => field.key !== geometryField && field.type !== 'geometry')
    .map((field) => field.key)
}
