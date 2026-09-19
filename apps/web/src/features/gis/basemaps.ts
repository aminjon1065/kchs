import type { Basemap, BasemapList, BasemapTheme, Locale } from '@kchs/contracts'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Protocol } from 'pmtiles'
import { useAppearance } from '~/app/appearance.js'
import { http } from '~/shared/api/client.js'

/**
 * Базовые карты (07-gis-engine.md §5, ADR-0066): реестр установки и стиль
 * MapLibre темы. Стиль собирает API — с абсолютными адресами архива PMTiles,
 * растровых тайлов, шрифтов и спрайтов; клиенту остаётся протокол `pmtiles://`
 * и перенос адресов API на origin страницы (`rebaseApiUrls`).
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

/** Адрес API в стиле подложки: `[pmtiles://]схема://хост/api/v1/…`. */
const API_URL = /^(pmtiles:\/\/)?https?:\/\/[^/]+(\/api\/v1\/)/

/**
 * Адреса API в стиле подложки — к origin страницы. Сервер строит их от
 * `KCHS_BASE_URL`, а страницу открывают и по другим адресам: внутреннее имя или
 * IP установки, веб для движка печати (ADR-0078). Чужой origin не пропустит CSP
 * (`connect-src 'self'`), и cookie сессии к нему не уйдёт — подложка не
 * загрузилась бы. Совпадают адреса — ничего не меняется.
 */
export function rebaseApiUrls<T>(value: T, origin: string): T {
  if (typeof value === 'string') {
    return value.replace(
      API_URL,
      (_match, protocol: string | undefined, path: string) => `${protocol ?? ''}${origin}${path}`,
    ) as T
  }
  if (Array.isArray(value)) return value.map((item) => rebaseApiUrls(item, origin)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebaseApiUrls(item, origin)]),
    ) as T
  }
  return value
}

/** Версия подложки — в ключе: правка адреса или новая сборка дают новый стиль. */
const basemapStyleQuery = (
  basemap: Pick<Basemap, 'id' | 'version'>,
  theme: BasemapTheme,
  lang: Locale,
) =>
  queryOptions({
    queryKey: basemapKeys.style(basemap.id, basemap.version, theme, lang),
    queryFn: async () =>
      rebaseApiUrls(
        await http.get<BasemapStyle>(`/gis/basemaps/${basemap.id}/style.json`, {
          query: { theme, lang },
        }),
        window.location.origin,
      ),
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
