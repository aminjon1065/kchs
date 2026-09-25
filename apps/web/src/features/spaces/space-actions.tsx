import type { Space } from '@kchs/contracts'
import {
  AlertDialog,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Пространство целиком (ADR-0152): переименование, архив вместе с содержимым и
 * возврат, удаление архивного или пустого. Пункты — по действиям, которые сервер
 * разрешил на объекте пространства (`space.manage`, `space.archive`, `space.delete`).
 */
export function SpaceActions({ space, allowed }: { space: Space; allowed: readonly string[] }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null)
  const archived = Boolean(space.archivedAt)
  const canRename = allowed.includes('space.manage') && !archived
  const canArchive = allowed.includes('space.archive')
  const canDelete = allowed.includes('space.delete')

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['spaces'] })
    void client.invalidateQueries({ queryKey: ['object', space.id] })
    void client.invalidateQueries({ queryKey: ['objects'] })
  }
  const fail = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))

  const archive = useMutation({
    mutationFn: () => http.post(`/spaces/${space.id}/${archived ? 'unarchive' : 'archive'}`),
    onSuccess: () => {
      setConfirm(null)
      refresh()
      toast.show({
        title: t(archived ? 'spaces.lifecycle.unarchived' : 'spaces.lifecycle.archived'),
        tone: 'success',
      })
    },
    onError: (error) => {
      setConfirm(null)
      fail(error)
    },
  })
  const remove = useMutation({
    mutationFn: () => http.delete(`/spaces/${space.id}`),
    onSuccess: () => {
      setConfirm(null)
      refresh()
      toast.show({ title: t('spaces.lifecycle.deleted'), tone: 'info' })
    },
    onError: (error) => {
      setConfirm(null)
      fail(error)
    },
  })

  if (!canRename && !canArchive && !canDelete) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" label={t('spaces.lifecycle.actions', { name: space.name })}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRename ? (
            <DropdownMenuItem
              icon={<Pencil className="size-4" />}
              onSelect={() => setRenaming(true)}
            >
              {t('spaces.lifecycle.rename')}
            </DropdownMenuItem>
          ) : null}
          {canArchive ? (
            <DropdownMenuItem
              icon={
                archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />
              }
              onSelect={() => (archived ? archive.mutate() : setConfirm('archive'))}
            >
              {t(archived ? 'spaces.lifecycle.unarchive' : 'spaces.lifecycle.archive')}
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={<Trash2 className="size-4" />}
                danger
                onSelect={() => setConfirm('delete')}
              >
                {t('spaces.lifecycle.delete')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {renaming ? <RenameSpaceDialog space={space} onClose={() => setRenaming(false)} /> : null}
      <AlertDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={t('spaces.lifecycle.archiveTitle', { name: space.name })}
        description={t('spaces.lifecycle.archiveHint')}
        confirmLabel={t('spaces.lifecycle.archive')}
        loading={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
      <AlertDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={t('spaces.lifecycle.deleteTitle', { name: space.name })}
        description={t('spaces.lifecycle.deleteHint')}
        confirmLabel={t('spaces.lifecycle.delete')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}

/** Плашка архивного пространства: всё только для чтения, возврат — у кого есть право. */
export function ArchivedSpaceNotice({
  space,
  allowed,
}: {
  space: Space
  allowed: readonly string[]
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const unarchive = useMutation({
    mutationFn: () => http.post(`/spaces/${space.id}/unarchive`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['spaces'] })
      void client.invalidateQueries({ queryKey: ['object', space.id] })
      void client.invalidateQueries({ queryKey: ['objects'] })
      toast.show({ title: t('spaces.lifecycle.unarchived'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  if (!space.archivedAt) return null
  return (
    <Callout
      tone="warning"
      title={t('spaces.lifecycle.archivedTitle')}
      action={
        allowed.includes('space.archive') ? (
          <Button
            size="sm"
            variant="secondary"
            loading={unarchive.isPending}
            onClick={() => unarchive.mutate()}
          >
            {t('spaces.lifecycle.unarchive')}
          </Button>
        ) : undefined
      }
    >
      {t('spaces.lifecycle.archivedHint')}
    </Callout>
  )
}

function RenameSpaceDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      http.patch(`/spaces/${space.id}`, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['spaces'] })
      void client.invalidateQueries({ queryKey: ['object', space.id] })
      toast.show({ title: t('spaces.lifecycle.renamed'), tone: 'success' })
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('spaces.lifecycle.rename')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={name.trim().length === 0}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('common.labels.name')} required htmlFor={`${formId}-name`}>
            <Input
              id={`${formId}-name`}
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('spaces.lifecycle.description')} htmlFor={`${formId}-description`}>
            <Textarea
              id={`${formId}-description`}
              value={description}
              rows={3}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
