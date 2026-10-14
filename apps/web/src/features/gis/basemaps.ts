import {
  BASEMAP_THEMES,
  type Basemap,
  type BasemapTheme,
  type Locale,
  type ReliefLevel,
} from '@kchs/contracts'
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query'
import { useLocale } from '~/shared/appearance.js'
import { cachedFetch, OFFLINE_AWARE } from '~/shared/offline/queue.js'
import { autoBasemap, resolveBasemap, useBasemapChoice } from './basemap-choice.js'
import { wrapAssetUrls } from './offline/pack-source.js'
import { gisApi } from './queries.js'

/**
 * Базовые карты (07-gis-engine.md §5, ADR-0066): реестр установки и стиль
 * MapLibre темы. Стиль собирает API — с абсолютными адресами архива PMTiles,
 * растровых тайлов, шрифтов и спрайтов; клиенту остаётся протокол `pmtiles://`
 * и перенос адресов API на origin страницы (`rebaseApiUrls`).
 */

export const basemapKeys = {
  all: ['basemaps'] as const,
  style: (id: string, version: number, look: StyleLook, lang: Locale) =>
    ['basemaps', id, 'style', version, look.theme, look.relief, look.labels, lang] as const,
}

/** Реестр меняется редко: подложка по умолчанию — первой. */
export const basemapsQuery = () =>
  queryOptions({
    // Без сети — список с устройства: карта района открывается и так (ADR-0211)
    ...OFFLINE_AWARE,
    queryKey: basemapKeys.all,
    queryFn: () => cachedFetch('basemap-list', async () => (await gisApi.getBasemaps()).items),
    staleTime: 10 * 60_000,
  })

/** Вид стиля подложки: тема, сила рельефа и «Гибрид» (ADR-0196). */
interface StyleLook {
  theme: BasemapTheme
  relief: ReliefLevel
  labels: boolean
}

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
  look: StyleLook,
  lang: Locale,
) =>
  queryOptions({
    ...OFFLINE_AWARE,
    queryKey: basemapKeys.style(basemap.id, basemap.version, look, lang),
    queryFn: async () =>
      wrapAssetUrls(
        rebaseApiUrls(
          await cachedFetch(
            `basemap-style:${basemapKeys.style(basemap.id, basemap.version, look, lang).join(':')}`,
            () =>
              gisApi.getBasemapsStyleJson(basemap.id, {
                theme: look.theme,
                lang,
                relief: look.relief,
                labels: String(look.labels),
              }),
          ),
          window.location.origin,
        ),
      ),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * Стили подложки во всех темах — на устройство (ADR-0211): карта района без сети
 * откроется и в тёмной теме, и в окне поля-точки (серая схема).
 */
export function warmBasemapStyles(
  client: QueryClient,
  basemap: Pick<Basemap, 'id' | 'version'>,
  relief: ReliefLevel,
  lang: Locale,
): Promise<BasemapStyle[]> {
  return Promise.all(
    BASEMAP_THEMES.map((theme) =>
      client.fetchQuery(basemapStyleQuery(basemap, { theme, relief, labels: true }, lang)),
    ),
  )
}

export interface BasemapStyleOptions {
  /**
   * Светлая или тёмная тема интерфейса — для варианта «Схема», когда тема вида по умолчанию
   * `muted`; иначе берётся сама тема вида.
   */
  mode?: 'light' | 'dark'
  /** Личный выбор подложки (ADR-0196); печать и отчёты рисуют карту как задано. */
  personal?: boolean
}

/**
 * Подложка карты и её стиль: личный выбор сотрудника (ADR-0196), иначе `basemapId` из
 * MapSpec или, если он null либо подложку удалили, — подложка по умолчанию установки (нет
 * её — первая в списке). Тема — `light`/`dark` по оформлению интерфейса, `muted` — под
 * хороплеты и тепловые карты; язык подписей — язык интерфейса.
 * @public MapView карты-студии (P2-E01) берёт стиль отсюда.
 */
export function useBasemapStyle(
  basemapId: string | null,
  theme: BasemapTheme,
  options: BasemapStyleOptions = {},
) {
  const locale = useLocale()
  const personal = options.personal ?? true
  const choice = useBasemapChoice((state) => (personal ? state.choice : null))
  const relief = useBasemapChoice((state) => (personal ? state.relief : 'normal'))
  const basemaps = useQuery(basemapsQuery())
  const items = basemaps.data ?? []
  const mode = options.mode ?? (theme === 'dark' ? 'dark' : 'light')
  const resolved = resolveBasemap(items, choice, basemapId, theme, mode)
  const basemap = resolved.basemap
  const style = useQuery({
    ...basemapStyleQuery(
      basemap ?? { id: '', version: 0 },
      { theme: resolved.theme, relief, labels: resolved.labels },
      locale,
    ),
    enabled: basemap !== null,
  })
  return {
    basemap,
    /** Подложка «как в карте» — для переключателя. */
    auto: autoBasemap(items, basemapId),
    style: style.data ?? null,
    isLoading: basemaps.isLoading || (basemap !== null && style.isLoading),
    error: basemaps.error ?? style.error,
  }
}

/** Обработчик протокола карты — как его ждёт `addProtocol` MapLibre. */
type ProtocolHandler = (
  params: { url: string; type?: string },
  abort: AbortController,
) => Promise<{ data: unknown }>

let protocol: Promise<void> | null = null

/**
 * Протокол `pmtiles://` для MapLibre: векторная подложка читает архив диапазонами
 * через API, а то, что покрывает район на устройстве, — с устройства (ADR-0211).
 * Заодно протокол `kchs-asset://` шрифтов и значков подложки. Один раз на страницу —
 * повторный вызов ждёт первую регистрацию. Пакет `pmtiles` грузится лениво, отдельным
 * чанком карты; атрибуцию берёт из стиля — метаданные архива не читаются.
 * @public MapView карты-студии (P2-E01) вызывает до создания первой карты.
 */
export function registerPmtilesProtocol(maplibre: {
  addProtocol: (name: string, handler: ProtocolHandler) => void
}): Promise<void> {
  protocol ??= Promise.all([import('pmtiles'), import('./offline/pack-source.js')]).then(
    ([pmtiles, offline]) => {
      const handler = new pmtiles.Protocol()
      maplibre.addProtocol('pmtiles', (params, abort) => {
        const url = offline.archiveUrl(params.url)
        if (url && !handler.tiles.has(url)) {
          handler.add(new pmtiles.PMTiles(offline.packedSource(new pmtiles.FetchSource(url), url)))
        }
        return handler.tilev4(params as Parameters<typeof handler.tilev4>[0], abort)
      })
      maplibre.addProtocol(offline.ASSET_PROTOCOL, offline.loadAsset)
    },
  )
  return protocol
}
