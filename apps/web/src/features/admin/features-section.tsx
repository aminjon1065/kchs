import type { FeatureFlag, FeatureFlagList } from '@kchs/contracts'
import { Callout, Card, Skeleton, Switch, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'

/**
 * Возможности установки (15-admin-operations.md §1): организация выключает то,
 * чем не пользуется. Выключенное исчезает из оболочки, а его маршруты отвечают
 * «не найдено»; заведённые объекты остаются в базе и возвращаются вместе с
 * возможностью — поэтому их число видно прямо у переключателя.
 */
export function FeaturesSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()

  const { data } = useQuery({
    queryKey: keys.features,
    queryFn: () => http.get<FeatureFlagList>('/admin/features'),
  })

  const save = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      http.patch<FeatureFlagList>(`/admin/features/${key}`, { enabled }),
    onSuccess: (list) => {
      client.setQueryData(keys.features, list)
      // Оболочка прячет и показывает экраны по `/me`
      void client.invalidateQueries({ queryKey: keys.me })
      toast.show({ title: t('admin.features.saved'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!data) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <Callout tone="info">{t('admin.features.hint')}</Callout>
      <Card title={t('admin.features.title')}>
        <ul className="flex flex-col divide-y divide-line">
          {data.items.map((item) => (
            <FeatureRow
              key={item.key}
              item={item}
              onChange={(enabled) => save.mutate({ key: item.key, enabled })}
            />
          ))}
        </ul>
      </Card>
    </div>
  )
}

function FeatureRow({
  item,
  onChange,
}: {
  item: FeatureFlag
  onChange: (enabled: boolean) => void
}) {
  const t = useT()
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{t(item.titleKey)}</span>
        <span className="text-xs text-fg-secondary">{t(item.hintKey)}</span>
        {item.objects > 0 ? (
          <span className="text-2xs text-fg-muted">
            {item.enabled
              ? t('admin.features.objects', { count: item.objects })
              : t('admin.features.objectsWarning', { count: item.objects })}
          </span>
        ) : null}
      </div>
      <Switch
        checked={item.enabled}
        onCheckedChange={(next) => onChange(next)}
        aria-label={t(item.titleKey)}
      />
    </li>
  )
}
