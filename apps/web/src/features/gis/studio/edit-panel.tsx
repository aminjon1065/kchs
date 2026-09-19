import {
  Badge,
  Callout,
  EmptyState,
  IconButton,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { MousePointer2, PencilLine, X } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { objectQuery } from '~/shared/api/queries.js'
import { datasetQuery } from '../../data/queries.js'
import { layerEditingQuery } from '../edit/edit-api.js'
import { EditQueue } from '../edit/edit-queue.js'
import { editStore } from '../edit/edit-store.js'
import { FeatureForm } from '../edit/feature-form.js'
import { FeatureHistory } from '../edit/feature-history.js'
import { LayerEditSettings } from '../edit/layer-edit-settings.js'
import { useStudio } from './context.js'

/**
 * Правая панель правки (P2-E03 S02–S03, ADR-0076): атрибуты объекта по схеме
 * датасета, история и откат, правки модерируемого слоя — очередь проверки или
 * свои предложения; редактору слоя — настройки правки и модерации.
 */
export function EditPanel({ layerId }: { layerId: string | null }) {
  const t = useT()
  const studio = useStudio()
  const useSession = editStore(studio.mapId)
  const sessionLayer = useSession((s) => s.layerId)
  const target = useSession((s) => s.target)
  const tab = useSession((s) => s.tab)
  const setTab = useSession((s) => s.setTab)
  const id = sessionLayer ?? layerId
  const layer = id ? studio.layerById.get(id) : undefined
  const access = useQuery({ ...layerEditingQuery(id ?? ''), enabled: Boolean(id) })
  const { data: dataset } = useQuery({
    ...datasetQuery(layer?.datasetId ?? ''),
    enabled: Boolean(layer?.dataAccess),
  })
  const { data: object } = useQuery({ ...objectQuery(id ?? ''), enabled: Boolean(id) })

  if (!layer) {
    return <EmptyState compact icon={<PencilLine />} title={t('gis.edit.noLayer')} />
  }
  const canConfigure = ['edit', 'manage', 'owner'].includes(object?.level ?? 'view')
  const mode = access.data?.mode ?? 'none'
  const showEdits = layer.moderated && mode !== 'none'
  const current = tab === 'history' && !target?.rowId ? 'feature' : tab

  return (
    <section aria-label={t('gis.edit.panel')} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <PencilLine className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{layer.name}</h2>
        {mode === 'direct' ? (
          <Badge size="sm" tone="success">
            {t('gis.edit.modeDirect')}
          </Badge>
        ) : mode === 'suggest' ? (
          <Badge size="sm" tone="warning">
            {t('gis.edit.modeSuggest')}
          </Badge>
        ) : null}
        <IconButton label={t('common.actions.close')} size="sm" onClick={studio.closePanel}>
          <X className="size-4" aria-hidden />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {access.isLoading || !dataset ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <Tabs
            value={current}
            onValueChange={(next) => setTab(next as typeof tab)}
            className="flex flex-col"
          >
            <TabsList className="px-2">
              <TabsTrigger value="feature">{t('gis.edit.tabs.feature')}</TabsTrigger>
              {target?.rowId ? (
                <TabsTrigger value="history">{t('gis.edit.tabs.history')}</TabsTrigger>
              ) : null}
              {showEdits ? (
                <TabsTrigger value="edits" count={access.data?.pending || undefined}>
                  {access.data?.canReview ? t('gis.edit.tabs.review') : t('gis.edit.tabs.mine')}
                </TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="feature" className="p-3">
              {!sessionLayer ? (
                <Callout tone="info">{t('gis.edit.notEditing')}</Callout>
              ) : !target ? (
                <EmptyState
                  compact
                  icon={<MousePointer2 />}
                  title={t('gis.edit.idleTitle')}
                  description={t('gis.edit.idleHint')}
                />
              ) : access.data ? (
                <FeatureForm
                  key={`${target.rowId ?? 'new'}:${target.ver ?? 0}`}
                  layer={layer}
                  dataset={dataset}
                  access={access.data}
                />
              ) : null}
            </TabsContent>
            {target?.rowId && access.data ? (
              <TabsContent value="history" className="p-3">
                <FeatureHistory layer={layer} dataset={dataset} access={access.data} />
              </TabsContent>
            ) : null}
            {showEdits && access.data ? (
              <TabsContent value="edits" className="p-3">
                <EditQueue layer={layer} dataset={dataset} access={access.data} />
              </TabsContent>
            ) : null}
          </Tabs>
        )}
        {canConfigure ? (
          <div className="mt-auto flex flex-col gap-3 p-3">
            <Separator />
            <LayerEditSettings layer={layer} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
