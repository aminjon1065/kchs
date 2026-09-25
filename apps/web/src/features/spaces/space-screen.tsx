import { formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  AvatarGroup,
  Badge,
  Button,
  Card,
  cn,
  EmptyState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { FolderPlus, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { FilesScreen } from '~/features/files/files-screen.js'
import {
  objectListQuery,
  objectQuery,
  spaceMembersQuery,
  spacesQuery,
} from '~/shared/api/queries.js'
import { ArchivedSpaceNotice, SpaceActions } from './space-actions.js'
import { AddMemberDialog, MemberControls } from './space-members.js'

export function SpaceScreen({ spaceId }: { spaceId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const [tab, setTab] = useState('overview')

  const { data: spaces = [] } = useQuery(spacesQuery())
  const space = spaces.find((item) => item.id === spaceId)
  const { data: members = [], isLoading: membersLoading } = useQuery(spaceMembersQuery(spaceId))
  const { data: listed, isLoading } = useQuery(objectListQuery({ spaceId, limit: 50 }))
  // Объект самого пространства тоже принадлежит пространству — в содержимом он лишний
  const content = listed && { ...listed, items: listed.items.filter((item) => item.id !== spaceId) }
  // Приглашать может тот, кому объект пространства разрешает действие invite
  const { data: record } = useQuery(objectQuery(spaceId))
  // Действия реестра приходят с префиксом типа: `space.invite`
  const canInvite = record?.allowedActions.includes('space.invite') ?? false
  const [adding, setAdding] = useState(false)

  if (!space) {
    return isLoading ? (
      <div className="p-6">
        <Skeleton className="h-8 w-64" />
      </div>
    ) : (
      <EmptyState title={t('common.states.notFound')} description={t('spaces.unavailable')} />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="space" className="size-4 text-fg-muted" />
            <h1 className="truncate text-sm font-semibold text-fg">{space.name}</h1>
            <Badge size="sm">{t(`spaces.kinds.${space.kind}`)}</Badge>
            {space.archivedAt ? (
              <Badge size="sm" tone="warning">
                {t('spaces.lifecycle.archivedBadge')}
              </Badge>
            ) : null}
            <span className="tabular text-xs text-fg-muted">
              {t('admin.org.employees', { count: space.memberCount })}
            </span>
          </>
        }
        right={
          <>
            <AvatarGroup
              people={members.slice(0, 5).map((m) => ({ name: m.displayName, src: m.avatarUrl }))}
              size="sm"
            />
            {canInvite ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<UserPlus className="size-3.5" />}
                onClick={() => setAdding(true)}
              >
                {t('spaces.members.add')}
              </Button>
            ) : null}
            <SpaceActions space={space} allowed={record?.allowedActions ?? []} />
          </>
        }
      />

      <AddMemberDialog spaceId={spaceId} members={members} open={adding} onOpenChange={setAdding} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="overview">{t('objects.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="files" count={content?.items.filter((i) => i.type === 'file').length}>
            {t('shell.rail.files')}
          </TabsTrigger>
          <TabsTrigger value="members" count={space.memberCount}>
            {t('spaces.members.title')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto flex max-w-[1000px] flex-col gap-4">
            <ArchivedSpaceNotice space={space} allowed={record?.allowedActions ?? []} />
            {space.description ? (
              <Card>
                <p className="text-sm text-fg-secondary">{space.description}</p>
              </Card>
            ) : null}

            <Card title={t('spaces.content')} padded={false}>
              {isLoading ? (
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                  ))}
                </div>
              ) : !content?.items.length ? (
                <EmptyState
                  compact
                  icon={<FolderPlus />}
                  title={t('spaces.empty')}
                  description={t('spaces.emptyHint')}
                />
              ) : (
                <ul className="divide-y divide-line">
                  {content.items.slice(0, 12).map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() =>
                          openTab({
                            kind: 'object',
                            objectId: item.id,
                            objectType: item.type,
                            title: item.title,
                            mode: 'preview',
                          })
                        }
                        className={cn(
                          'flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2',
                        )}
                      >
                        <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                        <span className="shrink-0 text-2xs text-fg-muted">
                          {formatRelativeTime(item.updatedAt, { locale })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="files" className="min-h-0 flex-1">
          <FilesScreen spaceId={spaceId} />
        </TabsContent>

        <TabsContent value="members" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto max-w-[760px]">
            <Card title={t('spaces.members.title')} padded={false}>
              {membersLoading ? (
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {members.map((member) => (
                    <li key={member.userId} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar name={member.displayName} src={member.avatarUrl} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{member.displayName}</span>
                        <span className="block truncate text-xs text-fg-muted">
                          {[member.position, member.unitName].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </span>
                      {canInvite ? (
                        <MemberControls spaceId={spaceId} member={member} />
                      ) : (
                        <Badge tone={member.role === 'admin' ? 'accent' : 'neutral'} size="sm">
                          {t(`access.spaceRoles.${member.role}`)}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
