import type { Group, UserRef } from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { type PickedUser, UsersPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'

const groupsKey = ['groups'] as const

export const groupsQuery = () => ({
  queryKey: groupsKey,
  queryFn: async () => (await http.get<{ items: Group[] }>('/groups')).items,
})

const picked = (user: UserRef): PickedUser => ({
  id: user.id,
  title: user.displayName,
  subtitle: [user.position, user.unitName].filter(Boolean).join(' · ') || null,
  avatarUrl: user.avatarUrl,
})

/**
 * Группы (N86): получатели уведомлений и правил, адресаты прав доступа — например,
 * «Дежурная смена» пакета ЧС. Каталога у Комитета нет, поэтому состав ведётся
 * здесь; системные группы платформа считает сама, их не править.
 */
export function GroupsSection() {
  const t = useT()
  const { data: items = [], isLoading } = useQuery(groupsQuery())
  const [editing, setEditing] = useState<Group | 'new' | null>(null)

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <Card
        title={t('admin.groups.title')}
        padded={false}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setEditing('new')}
          >
            {t('admin.groups.create')}
          </Button>
        }
      >
        <p className="px-4 pt-3 text-xs text-fg-secondary">{t('admin.groups.hint')}</p>
        {!isLoading && items.length === 0 ? (
          <EmptyState compact title={t('admin.groups.empty')} />
        ) : (
          <div className="p-2">
            <DataTable
              aria-label={t('admin.groups.title')}
              rows={items}
              getRowId={(item) => item.id}
              loading={isLoading}
              onRowOpen={setEditing}
              onRowClick={setEditing}
              columns={[
                {
                  key: 'name',
                  header: t('admin.groups.name'),
                  cell: (item) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{item.name}</span>
                      {item.kind === 'system' ? (
                        <Badge size="sm" tone="neutral">
                          {t('admin.groups.system')}
                        </Badge>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: 'members',
                  header: t('admin.groups.members'),
                  width: 120,
                  align: 'end',
                  cell: (item) => <span className="tabular">{item.memberCount}</span>,
                },
                {
                  key: 'description',
                  header: t('admin.groups.description'),
                  cell: (item) => (
                    <span className="truncate text-fg-secondary">{item.description ?? '—'}</span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>
      {editing ? (
        <GroupDialog group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  )
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const system = group?.kind === 'system'
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [members, setMembers] = useState<PickedUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const { data: current } = useQuery({
    queryKey: ['groups', group?.id, 'members'],
    queryFn: async () =>
      (await http.get<{ items: UserRef[] }>(`/groups/${group?.id}/members`)).items,
    enabled: Boolean(group),
  })
  useEffect(() => {
    if (current) setMembers(current.map(picked))
  }, [current])

  const save = useMutation({
    mutationFn: async () => {
      let id = group?.id ?? null
      if (!id) {
        id = (
          await http.post<{ id: string }>('/groups', {
            name: name.trim(),
            description: description.trim() || null,
          })
        ).id
      } else if (
        name.trim() !== group?.name ||
        (description.trim() || null) !== group?.description
      ) {
        await http.patch(`/groups/${id}`, {
          name: name.trim(),
          description: description.trim() || null,
        })
      }
      await http.put(`/groups/${id}/members`, { userIds: members.map((user) => user.id) })
    },
    onSuccess: () => {
      toast.show({ title: t('admin.groups.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: groupsKey })
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={group ? group.name : t('admin.groups.create')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={system || name.trim().length === 0}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {system ? <Callout tone="info">{t('admin.groups.systemHint')}</Callout> : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.groups.name')} required htmlFor={`${formId}-name`}>
            <Input
              id={`${formId}-name`}
              value={name}
              disabled={system}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('admin.groups.description')} htmlFor={`${formId}-description`}>
            <Textarea
              id={`${formId}-description`}
              value={description}
              disabled={system}
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {system ? null : (
            <Field label={t('admin.groups.members')}>
              <UsersPicker
                value={members}
                onChange={setMembers}
                label={t('admin.groups.members')}
                addLabel={t('admin.groups.addMember')}
              />
            </Field>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
