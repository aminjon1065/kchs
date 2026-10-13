import type { Basemap } from '@kchs/contracts'
import { formatDate, formatFileSize } from '@kchs/fields'
import {
  Button,
  Callout,
  DialogContent,
  ProgressBar,
  SegmentedControl,
  Spinner,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useBasemapChoice } from '../basemap-choice.js'
import { basemapsQuery, warmBasemapStyles } from '../basemaps.js'
import { territoriesQuery, territoryQuery } from '../queries.js'
import { TerritorySelect } from '../territory-select.js'
import { type ArchivePlan, downloadPack, planArchive, styleArchives } from './pack-download.js'
import type { Bbox } from './pack-plan.js'
import { prefetchAssets } from './pack-source.js'
import { type BasemapPack, listPacks, removePack, storageEstimate } from './pack-store.js'
import { packStyle } from './queries.js'

/** Подробность района — наибольший масштаб тайлов на устройстве. */
const DETAIL = { overview: 10, villages: 12, streets: 14 } as const
type Detail = keyof typeof DETAIL

/** Населённый пункт без границы — рамка вокруг центра, около 5 км в каждую сторону. */
const POINT_BUFFER = 0.05

export const offlineKeys = {
  packs: ['gis', 'offline', 'packs'] as const,
  plan: (basemapId: string, version: number, territoryId: string, zoom: number) =>
    ['gis', 'offline', 'plan', basemapId, version, territoryId, zoom] as const,
}

/**
 * Векторная подложка, которую можно взять на устройство (ADR-0211): текущая, если она
 * векторная, иначе подложка по умолчанию или первая векторная.
 */
export function packableBasemap(items: readonly Basemap[], current: Basemap | null) {
  if (current?.kind === 'vector') return current
  const vectors = items.filter((item) => item.kind === 'vector')
  return vectors.find((item) => item.isDefault) ?? vectors[0] ?? null
}

/** Архивы подложки с рельефом: стиль запрашивается с рельефом, даже если он выключен. */
async function planPack(basemap: Basemap, bbox: Bbox, zoom: number, signal: AbortSignal) {
  const plans: ArchivePlan[] = []
  for (const url of styleArchives(await packStyle(basemap.id))) {
    // Адреса стиля — от KCHS_BASE_URL: к архиву идём по origin страницы
    const local = new URL(new URL(url).pathname, window.location.origin).href
    plans.push(await planArchive(local, bbox, zoom, signal))
  }
  return plans
}

function bboxOf(detail: { bbox: Bbox | null; centroid: { lon: number; lat: number } | null }) {
  if (detail.bbox) return detail.bbox
  if (!detail.centroid) return null
  const { lon, lat } = detail.centroid
  return [lon - POINT_BUFFER, lat - POINT_BUFFER, lon + POINT_BUFFER, lat + POINT_BUFFER] as Bbox
}

/**
 * Карта района без сети (ADR-0211): сотрудник выбирает район и подробность, видит объём
 * до загрузки и место на устройстве; районы на устройстве — с обновлением и удалением.
 */
export function OfflineBasemapDialog({ current }: { current: Basemap | null }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const relief = useBasemapChoice((state) => state.relief)
  const { data: basemaps = [] } = useQuery(basemapsQuery())
  const basemap = packableBasemap(basemaps, current)
  const { data: territories = [] } = useQuery(territoriesQuery())
  const [territoryId, setTerritoryId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail>('villages')
  const zoom = DETAIL[detail]
  const territory = useQuery({
    ...territoryQuery(territoryId ?? ''),
    enabled: territoryId !== null,
  })
  const bbox = territory.data ? bboxOf(territory.data) : null
  const plan = useQuery({
    queryKey: offlineKeys.plan(basemap?.id ?? '', basemap?.version ?? 0, territoryId ?? '', zoom),
    queryFn: ({ signal }) => planPack(basemap as Basemap, bbox as Bbox, zoom, signal),
    enabled: basemap !== null && bbox !== null,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const packs = useQuery({ queryKey: offlineKeys.packs, queryFn: listPacks })
  const storage = useQuery({
    queryKey: ['gis', 'offline', 'storage'],
    queryFn: storageEstimate,
  })
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const supported = typeof caches !== 'undefined'

  const size = (bytes: number) => formatFileSize(bytes, { locale })
  const nameOf = (id: string | null) => {
    const item = territories.find((entry) => entry.id === id)
    return item ? (item.name[locale] ?? item.name.ru) : ''
  }
  const plans = plan.data ?? []
  const bytes = plans.reduce((sum, item) => sum + item.bytes, 0)
  const tiles = plans.reduce((sum, item) => sum + item.tiles, 0)
  const vectorZoom = plans[0]?.maxZoom ?? zoom
  const tooBig = storage.data
    ? storage.data.quota > 0 && storage.data.usage + bytes > storage.data.quota * 0.9
    : false

  const refresh = () => {
    void client.invalidateQueries({ queryKey: offlineKeys.packs })
    void client.invalidateQueries({ queryKey: ['gis', 'offline', 'storage'] })
  }

  const download = async (input: {
    target: Basemap
    area: BasemapPack['area']
    plans: ArchivePlan[]
    zoom: number
  }) => {
    const controller = new AbortController()
    abort.current = controller
    try {
      await downloadPack(
        {
          id: `${input.target.id}:${input.area.territoryId ?? input.area.bbox.join(',')}`,
          basemapId: input.target.id,
          basemapName: input.target.name,
          build: input.target.build?.version ?? null,
          area: input.area,
          maxZoom: input.zoom,
          plans: input.plans,
        },
        (done, total) => setProgress({ done, total }),
        controller.signal,
      )
      // Стили, шрифты и значки — чтобы карта района открылась без сети с подписями
      const styles = await warmBasemapStyles(client, input.target, relief, locale).catch(() => [])
      await prefetchAssets(styles as Array<Record<string, unknown>>).catch(() => {})
      toast.success(t('gis.basemap.offline.downloaded'))
    } catch (error) {
      if (!controller.signal.aborted) toast.error(t('gis.basemap.offline.failed'))
      void error
    } finally {
      abort.current = null
      setProgress(null)
      refresh()
    }
  }

  const update = async (pack: BasemapPack) => {
    const target = basemaps.find((item) => item.id === pack.basemapId)
    if (!target) return
    const controller = new AbortController()
    const fresh = await planPack(target, pack.area.bbox, pack.maxZoom, controller.signal).catch(
      () => null,
    )
    if (!fresh) {
      toast.error(t('gis.basemap.offline.failed'))
      return
    }
    await download({ target, area: pack.area, plans: fresh, zoom: pack.maxZoom })
  }

  const remove = async (pack: BasemapPack) => {
    await removePack(pack.id)
    toast.success(t('gis.basemap.offline.removed'))
    refresh()
  }

  return (
    <DialogContent
      title={t('gis.basemap.offline.title')}
      description={t('gis.basemap.offline.description')}
      size="md"
    >
      <div className="flex flex-col gap-4">
        {!supported ? (
          <Callout tone="warning">{t('gis.basemap.offline.unsupported')}</Callout>
        ) : !basemap ? (
          <Callout tone="info">{t('gis.basemap.offline.vectorOnly')}</Callout>
        ) : (
          <div className="flex flex-col gap-3">
            {current && current.kind !== 'vector' ? (
              <Callout tone="info">{t('gis.basemap.offline.vectorOnly')}</Callout>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg-muted">{t('gis.basemap.offline.area')}</span>
              <TerritorySelect
                value={territoryId ? { id: territoryId, includeChildren: true } : null}
                onChange={(value) => setTerritoryId(value?.id ?? null)}
                label={t('gis.basemap.offline.chooseArea')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg-muted">{t('gis.basemap.offline.detail')}</span>
              <SegmentedControl
                aria-label={t('gis.basemap.offline.detail')}
                value={detail}
                onValueChange={setDetail}
                size="sm"
                options={(Object.keys(DETAIL) as Detail[]).map((key) => ({
                  value: key,
                  label: t(`gis.basemap.offline.detailLevels.${key}`),
                }))}
              />
            </div>
            {territoryId === null ? null : plan.isFetching || territory.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Spinner className="size-3.5" />
                {t('gis.basemap.offline.estimating')}
              </div>
            ) : plan.data ? (
              <div className="flex flex-col gap-1 text-sm" data-testid="offline-estimate">
                <span>
                  {t('gis.basemap.offline.estimate', {
                    size: size(bytes),
                    tiles: tiles.toLocaleString(locale),
                  })}
                </span>
                {vectorZoom < zoom ? (
                  <span className="text-fg-muted">
                    {t('gis.basemap.offline.reduced', { zoom: vectorZoom })}
                  </span>
                ) : null}
                {tooBig ? (
                  <Callout tone="warning">{t('gis.basemap.offline.tooBig')}</Callout>
                ) : null}
              </div>
            ) : plan.isError ? (
              <Callout tone="danger">{t('gis.basemap.offline.failed')}</Callout>
            ) : null}
            {progress ? (
              <div className="flex items-center gap-2">
                <ProgressBar
                  value={progress.done}
                  max={Math.max(progress.total, 1)}
                  className="flex-1"
                  label={t('gis.basemap.offline.download')}
                  showValue
                />
                <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                  {t('gis.basemap.offline.cancel')}
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  size="sm"
                  disabled={!plan.data || !bbox || tooBig || progress !== null}
                  onClick={() =>
                    plan.data && bbox
                      ? void download({
                          target: basemap,
                          area: { territoryId, name: nameOf(territoryId), bbox },
                          plans: plan.data,
                          zoom: vectorZoom,
                        })
                      : undefined
                  }
                >
                  {t('gis.basemap.offline.download')}
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-sm font-medium">{t('gis.basemap.offline.packs')}</span>
          {(packs.data ?? []).length === 0 ? (
            <span className="text-sm text-fg-muted">{t('gis.basemap.offline.empty')}</span>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('gis.basemap.offline.packs')}>
              {(packs.data ?? []).map((pack) => {
                const target = basemaps.find((item) => item.id === pack.basemapId)
                const outdated =
                  target !== undefined && (target.build?.version ?? null) !== pack.build
                return (
                  <li key={pack.id} className="flex items-center gap-2 text-sm">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">
                        {pack.area.name} · {pack.basemapName}
                      </span>
                      <span className="text-fg-muted">
                        {t('gis.basemap.offline.packMeta', {
                          size: size(pack.bytes),
                          zoom: pack.maxZoom,
                          date: formatDate(new Date(pack.createdAt), { locale }),
                        })}
                      </span>
                      {outdated ? (
                        <span className="text-warning">{t('gis.basemap.offline.outdated')}</span>
                      ) : null}
                    </div>
                    {outdated ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={progress !== null}
                        onClick={() => void update(pack)}
                      >
                        {t('gis.basemap.offline.update')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={progress !== null}
                      onClick={() => void remove(pack)}
                    >
                      {t('gis.basemap.offline.remove')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {storage.data && storage.data.quota > 0 ? (
            <span className="text-xs text-fg-muted">
              {t('gis.basemap.offline.storage', {
                usage: size(storage.data.usage),
                quota: size(storage.data.quota),
              })}
            </span>
          ) : null}
        </div>
      </div>
    </DialogContent>
  )
}
