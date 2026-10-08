import type { Basemap, ReliefLevel } from '@kchs/contracts'
import { RELIEF_LEVELS } from '@kchs/contracts'
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioItem,
  SegmentedControl,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import { useT } from '~/shared/i18n.js'
import { type BasemapVariant, useBasemapChoice, variantsOf } from './basemap-choice.js'
import { basemapsQuery } from './basemaps.js'

const AUTO = 'auto'

interface Option {
  value: string
  title: string
  hint: string | null
}

/** Порядок в списке: векторные, растровые, «без подложки» последней. */
const RANK: Record<string, number> = { vector: 0, raster: 1, wms: 1, wmts: 1, none: 2 }

/**
 * Выбор подложки на карте (ADR-0196): кнопка в столбце управления карты, в окне — подложки
 * реестра с вариантами (схема, серая, снимок, «Гибрид») и сила рельефа. Выбор личный и
 * запоминается в браузере для всех карт; автор карты может сделать выбранную подложку
 * подложкой карты — для всех.
 */
export function BasemapSwitcher({
  auto,
  current,
  mapAware = false,
  onSaveToMap,
}: {
  /** Подложка «как в карте» (или по умолчанию установки). */
  auto: Basemap | null
  /** Подложка, которую карта рисует сейчас. */
  current: Basemap | null
  /** Вид карты-объекта: первый вариант — «Как в карте», иначе — «По умолчанию». */
  mapAware?: boolean
  /** Редактор карты: сохранить выбранную подложку в карте. */
  onSaveToMap?: (basemapId: string) => void
}) {
  const t = useT()
  const { data: items = [] } = useQuery(basemapsQuery())
  const choice = useBasemapChoice((state) => state.choice)
  const relief = useBasemapChoice((state) => state.relief)
  const choose = useBasemapChoice((state) => state.choose)
  const setRelief = useBasemapChoice((state) => state.setRelief)

  const label = (item: Basemap, variant: BasemapVariant): Omit<Option, 'value'> => {
    if (item.kind === 'none') return { title: t('gis.map.noBasemap'), hint: null }
    if (variant === 'scheme') return { title: t('gis.basemap.scheme'), hint: item.name }
    if (variant === 'muted') {
      return { title: t('gis.basemap.muted'), hint: t('gis.basemap.mutedHint') }
    }
    if (variant === 'hybrid') {
      return { title: t('gis.basemap.hybrid'), hint: t('gis.basemap.hybridHint') }
    }
    return { title: item.name, hint: null }
  }

  const options: Option[] = [
    {
      value: AUTO,
      title: t(mapAware ? 'gis.basemap.auto' : 'gis.basemap.autoDefault'),
      hint: auto ? (auto.kind === 'none' ? t('gis.map.noBasemap') : auto.name) : null,
    },
    ...[...items]
      .sort((a, b) => (RANK[a.kind] ?? 1) - (RANK[b.kind] ?? 1))
      .flatMap((item) =>
        variantsOf(item, items).map((variant) => ({
          value: `${item.id}:${variant}`,
          ...label(item, variant),
        })),
      ),
  ]
  const selected =
    choice && options.some((option) => option.value === `${choice.basemapId}:${choice.variant}`)
      ? `${choice.basemapId}:${choice.variant}`
      : AUTO
  const hasRelief = current?.kind === 'vector' && current.build?.relief != null
  const canSave = onSaveToMap && choice && selected !== AUTO && choice.basemapId !== auto?.id

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={t('gis.basemap.open')} size="sm">
          <Layers className="size-4" aria-hidden />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="flex w-72 flex-col gap-3">
        <p className="text-xs font-semibold text-fg">{t('gis.basemap.title')}</p>
        <RadioGroup
          value={selected}
          onValueChange={(value) => {
            if (value === AUTO) {
              choose(null)
              return
            }
            const [basemapId = '', variant] = value.split(':')
            choose({ basemapId, variant: variant as BasemapVariant })
          }}
          aria-label={t('gis.basemap.title')}
          className="flex max-h-72 flex-col gap-2 overflow-auto"
        >
          {options.map((option) => (
            <RadioItem
              key={option.value}
              value={option.value}
              label={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.title}</span>
                  {option.hint ? (
                    <span className="truncate text-xs text-fg-muted">{option.hint}</span>
                  ) : null}
                </span>
              }
            />
          ))}
        </RadioGroup>
        {hasRelief ? (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <p className="text-xs font-semibold text-fg">{t('gis.basemap.relief')}</p>
            <SegmentedControl<ReliefLevel>
              size="sm"
              value={relief}
              onValueChange={setRelief}
              aria-label={t('gis.basemap.relief')}
              options={RELIEF_LEVELS.map((level) => ({
                value: level,
                label: t(`gis.basemap.reliefLevels.${level}`),
              }))}
            />
          </div>
        ) : null}
        {canSave && choice ? (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <Button size="sm" variant="secondary" onClick={() => onSaveToMap(choice.basemapId)}>
              {t('gis.basemap.saveToMap')}
            </Button>
            <p className="text-xs text-fg-muted">{t('gis.basemap.saveToMapHint')}</p>
          </div>
        ) : null}
        <p className="text-xs text-fg-muted">{t('gis.basemap.personalHint')}</p>
      </PopoverContent>
    </Popover>
  )
}
