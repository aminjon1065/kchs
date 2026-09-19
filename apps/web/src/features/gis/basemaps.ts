import type { Basemap, BasemapList, BasemapTheme, Locale } from '@kchs/contracts'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Protocol } from 'pmtiles'
import { useAppearance } from '~/app/appearance.js'
import { http } from '~/shared/api/client.js'

/**
 * Базовые карты (07-gis-engine.md §5, ADR-0066): реестр установки и стиль
 * MapLibre темы. Стиль собирает API — с абсолютными адресами архива PMTiles,
 * растровых тайлов, шрифтов и спрайтов; клиенту остаётся протокол `pmtiles://`.
 */

export const basemapKeys = {
  all: ['basemaps'] as const,
  style: (id: string, version: number, theme: BasemapTheme, lang: Locale) =>
    ['basemaps', id, 'style', version, theme, lang] as const,
}

/** Реестр меняется редко: подложка по умолчанию — первой. */
export const basemapsQuery = () =>
  queryOptions({
    queryKey: basemapKeys.all,
    queryFn: async () => (await http.get<BasemapList>('/gis/basemaps')).items,
    staleTime: 10 * 60_000,
  })

/** Стиль MapLibre (спецификация v8) — как отдал сервер, для `map.setStyle`. */
export type BasemapStyle = Record<string, unknown>

/** Версия подложки — в ключе: правка адреса или новая сборка дают новый стиль. */
const basemapStyleQuery = (
  basemap: Pick<Basemap, 'id' | 'version'>,
  theme: BasemapTheme,
  lang: Locale,
) =>
  queryOptions({
    queryKey: basemapKeys.style(basemap.id, basemap.version, theme, lang),
    queryFn: () =>
      http.get<BasemapStyle>(`/gis/basemaps/${basemap.id}/style.json`, { query: { theme, lang } }),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * Подложка карты и её стиль: `basemapId` из MapSpec или, если он null либо
 * подложку удалили, — подложка по умолчанию установки (нет её — первая в списке). Тема — `light`/`dark`
 * по оформлению интерфейса, `muted` — под хороплеты и тепловые карты; язык
 * подписей — язык интерфейса.
 * @public MapView карты-студии (P2-E01) берёт стиль отсюда.
 */
export function useBasemapStyle(basemapId: string | null, theme: BasemapTheme) {
  const locale = useAppearance((s) => s.locale)
  const basemaps = useQuery(basemapsQuery())
  const items = basemaps.data ?? []
  const basemap =
    items.find((item) => item.id === basemapId) ??
    items.find((item) => item.isDefault) ??
    items[0] ??
    null
  const style = useQuery({
    ...basemapStyleQuery(basemap ?? { id: '', version: 0 }, theme, locale),
    enabled: basemap !== null,
  })
  return {
    basemap,
    style: style.data ?? null,
    isLoading: basemaps.isLoading || (basemap !== null && style.isLoading),
    error: basemaps.error ?? style.error,
  }
}

let protocol: Promise<void> | null = null

/**
 * Протокол `pmtiles://` для MapLibre: векторная подложка читает архив диапазонами
 * через API. Один раз на страницу — повторный вызов ждёт первую регистрацию.
 * Пакет `pmtiles` грузится лениво, отдельным чанком карты; атрибуцию берёт из
 * стиля — метаданные архива не читаются.
 * @public MapView карты-студии (P2-E01) вызывает до создания первой карты.
 */
export function registerPmtilesProtocol(maplibre: {
  addProtocol: (name: string, handler: Protocol['tile']) => void
}): Promise<void> {
  protocol ??= import('pmtiles').then((pmtiles) => {
    maplibre.addProtocol('pmtiles', new pmtiles.Protocol().tile)
  })
  return protocol
}
