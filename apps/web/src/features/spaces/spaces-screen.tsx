import { formatRelativeTime } from '@kchs/fields'
import { Badge, Button, cn, EmptyState, ObjectIcon, PanelToolbar, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { LayoutGrid, Plus } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { CreateSpaceDialog } from './create-space-dialog.js'

export function SpacesScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: spaces = [], isLoading } = useQuery(spacesQuery())

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('spaces.title')}</h1>}
        right={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setCreateOpen(true)}
          >
            {t('spaces.create.title')}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        ) : spaces.length === 0 ? (
          <EmptyState icon={<LayoutGrid />} title={t('shell.navigator.empty')} />
        ) : (
          <div className="mx-auto grid max-w-[1100px] gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {spaces.map((space) => (
              <button
                key={space.id}
                type="button"
                onClick={() =>
                  openTab({
                    kind: 'screen',
                    screen: 'space',
                    title: space.name,
                    icon: 'space',
                    params: { spaceId: space.id },
                    mode: 'permanent',
                  })
                }
                className={cn(
                  'flex flex-col items-start gap-2 rounded-lg border border-line bg-surface p-4 text-left',
                  'transition-colors hover:border-line-strong hover:bg-surface-2',
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <ObjectIcon type="space" className="size-4 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {space.name}
                  </span>
                  <Badge size="sm">{t(`spaces.kinds.${space.kind}`)}</Badge>
                </div>
                {space.description ? (
                  <p className="line-clamp-2 text-xs text-fg-secondary">{space.description}</p>
                ) : null}
                <div className="mt-auto flex w-full items-center gap-3 text-2xs text-fg-muted">
                  <span className="tabular">
                    {t('admin.org.employees', { count: space.memberCount })}
                  </span>
                  <span className="ml-auto">{formatRelativeTime(space.updatedAt, { locale })}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <CreateSpaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
