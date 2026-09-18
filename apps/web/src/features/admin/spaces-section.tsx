import type { AdminSpace, PrincipalRef } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  SearchInput,
  Skeleton,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, UserCog } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { adminSpacesQuery, principalsQuery } from '~/shared/api/queries.js'

/**
 * «Пространства» (15-admin-operations.md): все пространства организации,
 * состав и администраторы. Если администратор ушёл, администратор системы
 * назначает нового — с записью в аудит.
 */
export function SpacesSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search, 250)
  const { data: spaces = [], isLoading } = useQuery(adminSpacesQuery({ q: query || undefined }))
  const [assigning, setAssigning] = useState<AdminSpace | null>(null)

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.spaces.hint')}</p>
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('admin.spaces.searchPlaceholder')}
        className="max-w-sm"
      />
      <Card padded={false} className="overflow-x-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : spaces.length === 0 ? (
          <EmptyState compact icon={<LayoutGrid />} title={t('admin.spaces.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="h-8 px-3 font-medium">{t('admin.spaces.columns.name')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.spaces.columns.kind')}</th>
                <th className="h-8 px-3 text-right font-medium">
                  {t('admin.spaces.columns.members')}
                </th>
                <th className="h-8 px-3 font-medium">{t('admin.spaces.columns.admins')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.spaces.columns.created')}</th>
                <th className="h-8 w-10 px-3 font-medium">
                  <span className="sr-only">{t('ui.table.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((space) => (
                <tr
                  key={space.id}
                  className="border-b border-line last:border-0 hover:bg-surface-2"
                >
                  <td className="h-(--row-h) px-3">
                    <span className="block text-fg">{space.name}</span>
                    <span className="block font-mono text-2xs text-fg-muted">{space.key}</span>
                  </td>
                  <td className="px-3 text-xs text-fg-secondary">
                    {t(`spaces.kinds.${space.kind}`)}
                  </td>
                  <td className="tabular px-3 text-right text-xs text-fg-secondary">
                    {space.memberCount}
                  </td>
                  <td className="px-3">
                    {space.admins.length === 0 ? (
                      <Badge tone="warning" size="sm" dot>
                        {t('admin.spaces.noAdmins')}
                      </Badge>
                    ) : (
                      <span className="text-xs whitespace-nowrap text-fg-secondary">
                        {space.admins.map((admin) => admin.displayName).join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 text-xs whitespace-nowrap text-fg-muted">
                    {formatDate(space.createdAt, { locale })}
                  </td>
                  <td className="px-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<UserCog className="size-3.5" />}
                      aria-label={t('admin.spaces.assignAdminOf', { name: space.name })}
                      onClick={() => setAssigning(space)}
                    >
                      {t('admin.spaces.assignAdmin')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <AssignAdminDialog space={assigning} onClose={() => setAssigning(null)} />
    </div>
  )
}

function AssignAdminDialog({ space, onClose }: { space: AdminSpace | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<PrincipalRef | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = useDebouncedValue(search, 200)
  const { data: candidates = [] } = useQuery(principalsQuery(query, 'user'))

  const close = () => {
    onClose()
    setSearch('')
    setPicked(null)
    setError(null)
  }

  const assign = useMutation({
    mutationFn: () => http.post(`/admin/spaces/${space?.id}/admins`, { userId: picked?.id }),
    onSuccess: () => {
      toast.show({
        title: t('admin.spaces.assigned', { name: picked?.title ?? '' }),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: ['admin', 'spaces'] })
      close()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open={space !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        title={t('admin.spaces.assignTitle', { name: space?.name ?? '' })}
        description={t('admin.spaces.assignHint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!picked}
              loading={assign.isPending}
              onClick={() => assign.mutate()}
            >
              {t('admin.spaces.assign')}
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
                        onClick={() => setPicked(candidate)}
                        className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                      >
                        <Avatar name={candidate.title} src={candidate.avatarUrl} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Field>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
