import type { PassportMetric, TerritoryDetail } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  RadioGroup,
  RadioItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'

type Scope = 'self' | 'root'

/**
 * Показатели паспорта (07-gis-engine.md §11: «настраиваемая сетка»): показатель
 * привязывается к территории связью `about_territory` и считается в паспорте
 * этой единицы и всех вложенных; привязка к стране — во всех паспортах. Связь
 * меняет тот, кто может править показатель.
 */
export function PassportMetricsDialog({
  territory,
  metrics,
  onClose,
}: {
  territory: TerritoryDetail
  metrics: readonly PassportMetric[]
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const [metricId, setMetricId] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('self')
  const [failure, setFailure] = useState<string | null>(null)
  const { data: available } = useQuery(objectListQuery({ types: 'metric', limit: 100 }))
  const root = territory.path[0] ?? territory
  const nameOf = (item: { name: TerritoryDetail['name'] }) => item.name[locale] ?? item.name.ru
  const linked = new Set(metrics.map((metric) => metric.metricId))

  const refresh = () =>
    client.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'territory' && query.queryKey[2] === 'passport',
    })
  const link = useMutation({
    mutationFn: () =>
      http.post(`/objects/${metricId}/links`, {
        targetId: scope === 'root' ? root.id : territory.id,
        kind: 'about_territory',
      }),
    onSuccess: () => {
      setMetricId(null)
      setFailure(null)
      void refresh()
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const unlink = useMutation({
    mutationFn: (metric: PassportMetric) =>
      http.delete(`/objects/${metric.metricId}/links/${metric.linkedTo}/about_territory`),
    onSuccess: () => void refresh(),
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.passport.metricsTitle')}
        size="md"
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <p className="text-xs text-fg-muted">{t('gis.passport.metricsHint')}</p>
          {metrics.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {metrics.map((metric) => (
                <li key={metric.metricId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-fg">{metric.name}</span>
                  <span className="shrink-0 text-xs text-fg-muted">
                    {metric.linkedTo === territory.id
                      ? t('gis.passport.linkedHere')
                      : t('gis.passport.linkedAbove')}
                  </span>
                  <IconButton
                    size="sm"
                    label={t('gis.passport.unlinkMetric', { name: metric.name })}
                    onClick={() => unlink.mutate(metric)}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
          <Field label={t('gis.passport.addMetric')}>
            <Select value={metricId ?? ''} onValueChange={setMetricId}>
              <SelectTrigger aria-label={t('gis.passport.addMetric')}>
                <SelectValue placeholder={t('gis.passport.chooseMetric')} />
              </SelectTrigger>
              <SelectContent>
                {(available?.items ?? [])
                  .filter((item) => !linked.has(item.id))
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <RadioGroup
            value={scope}
            onValueChange={(value) => setScope(value as Scope)}
            className="flex flex-col gap-2"
          >
            <RadioItem
              value="self"
              label={t('gis.passport.scopeSelf', { name: nameOf(territory) })}
            />
            {root.id !== territory.id ? (
              <RadioItem value="root" label={t('gis.passport.scopeRoot', { name: nameOf(root) })} />
            ) : null}
          </RadioGroup>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={!metricId}
              loading={link.isPending}
              onClick={() => link.mutate()}
            >
              {t('gis.passport.linkMetric')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
