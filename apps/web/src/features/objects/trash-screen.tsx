import { formatRelativeTime } from '@kchs/fields'
import { Button, Card, EmptyState, ObjectIcon, PanelToolbar, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { trashQuery } from '~/shared/api/queries.js'

export function TrashScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()

  const { data: items = [], isLoading } = useQuery(trashQuery())

  const restore = useMutation({
    mutationFn: (objectId: string) => http.post(`/objects/${objectId}/restore`),
    onSuccess: () => {
      toast.show({ title: t('objects.trash.restored'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['trash'] })
      void client.invalidateQueries({ queryKey: ['objects'] })
    },
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('objects.trash.title')}</h1>}
        right={<span className="text-xs text-fg-muted">{t('objects.trash.hint')}</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
        <div className="mx-auto max-w-[820px]">
          {isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={<Trash2 />} title={t('objects.trash.empty')} />
          ) : (
            <Card padded={false}>
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{item.title}</span>
                      <span className="block text-xs text-fg-muted">
                        {t(`objects.types.${item.type}`)} ·{' '}
                        {formatRelativeTime(item.updatedAt, { locale })}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw className="size-3.5" />}
                      loading={restore.isPending}
                      onClick={() => restore.mutate(item.id)}
                    >
                      {t('objects.trash.restore')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
