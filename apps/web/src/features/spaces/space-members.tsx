import { type PrincipalRef, SPACE_ROLES, type SpaceMember, type SpaceRole } from '@kchs/contracts'
import {
  Avatar,
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserMinus } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, principalsQuery } from '~/shared/api/queries.js'

function useRefreshMembers(spaceId: string) {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: keys.spaceMembers(spaceId) })
    void client.invalidateQueries({ queryKey: keys.spaces })
  }
}

/** Приглашение в пространство (P0-E05 S02): сотрудник и роль пространства. */
export function AddMemberDialog({
  spaceId,
  members,
  open,
  onOpenChange,
}: {
  spaceId: string
  members: SpaceMember[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const refresh = useRefreshMembers(spaceId)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<PrincipalRef | null>(null)
  const [role, setRole] = useState<SpaceRole>('member')
  const [error, setError] = useState<string | null>(null)
  const query = useDebouncedValue(search, 200)
  const { data: candidates = [] } = useQuery(principalsQuery(query, 'user'))
  const already = new Set(members.map((member) => member.userId))

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setSearch('')
      setPicked(null)
      setRole('member')
      setError(null)
    }
  }

  const add = useMutation({
    mutationFn: () => http.post(`/spaces/${spaceId}/members`, { userId: picked?.id, role }),
    onSuccess: () => {
      toast.show({
        title: t('spaces.members.added', { name: picked?.title ?? '' }),
        tone: 'success',
      })
      refresh()
      close(false)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('spaces.members.add')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!picked}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('common.actions.add')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {picked ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
              <Avatar name={picked.title} src={picked.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{picked.title}</span>
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                {t('common.actions.edit')}
              </Button>
            </div>
          ) : (
            <Field label={t('spaces.members.person')}>
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder={t('spaces.members.searchPlaceholder')}
                autoFocus
              />
              {query && candidates.length > 0 ? (
                <ul
                  aria-label={t('spaces.members.candidates')}
                  className="mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-surface p-1"
                >
                  {candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        disabled={already.has(candidate.id)}
                        onClick={() => setPicked(candidate)}
                        className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Avatar name={candidate.title} src={candidate.avatarUrl} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{candidate.title}</span>
                          <span className="block truncate text-xs text-fg-muted">
                            {already.has(candidate.id)
                              ? t('spaces.members.alreadyMember')
                              : (candidate.subtitle ?? '')}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Field>
          )}
          <Field label={t('spaces.members.role')}>
            <RoleSelect value={role} onChange={setRole} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RoleSelect({
  value,
  onChange,
  label,
}: {
  value: SpaceRole
  onChange: (role: SpaceRole) => void
  label?: string
}) {
  const t = useT()
  return (
    <Select value={value} onValueChange={(next) => onChange(next as SpaceRole)}>
      <SelectTrigger aria-label={label ?? t('spaces.members.role')} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SPACE_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`access.spaceRoles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Роль участника и исключение из пространства — для тех, кто вправе приглашать. */
export function MemberControls({ spaceId, member }: { spaceId: string; member: SpaceMember }) {
  const t = useT()
  const toast = useToast()
  const refresh = useRefreshMembers(spaceId)
  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('errors.unknown'))

  const change = useMutation({
    mutationFn: (role: SpaceRole) =>
      http.put(`/spaces/${spaceId}/members/${member.userId}`, { role }),
    onSuccess: refresh,
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: () => http.delete(`/spaces/${spaceId}/members/${member.userId}`),
    onSuccess: () => {
      toast.show({ title: t('spaces.members.removed', { name: member.displayName }), tone: 'info' })
      refresh()
    },
    onError: failed,
  })

  return (
    <div className="flex items-center gap-1">
      <RoleSelect
        value={member.role}
        onChange={(role) => change.mutate(role)}
        label={t('spaces.members.roleOf', { name: member.displayName })}
      />
      <IconButton
        size="sm"
        label={t('spaces.members.removeOf', { name: member.displayName })}
        onClick={() => remove.mutate()}
      >
        <UserMinus className="size-4" />
      </IconButton>
    </div>
  )
}
