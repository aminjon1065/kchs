import type { NamedWorkspace, NamedWorkspaceSummary } from '@kchs/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutPanelLeft, Pin, Save, Trash2, Upload } from 'lucide-react'
import { useId, useState } from 'react'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, spacesQuery, workspacesQuery } from '~/shared/api/queries.js'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'

/** Открыть сохранённое рабочее пространство с возможностью вернуть прежние вкладки. */
export function useOpenWorkspace() {
  const t = useT()
  const toast = useToast()
  const applyLayout = useWorkspace((s) => s.applyLayout)
  const restore = useWorkspace((s) => s.restore)
  const takeSnapshot = useWorkspace((s) => s.snapshot)

  return async (summary: Pick<NamedWorkspaceSummary, 'id' | 'title'>) => {
    try {
      const workspace = await http.get<NamedWorkspace>(`/workspaces/${summary.id}`)
      const previous = takeSnapshot()
      applyLayout(workspace.layout)
      toast.show({
        title: t('shell.workspaces.opened', { title: workspace.title }),
        tone: 'info',
        action: { label: t('shell.workspaces.undo'), onClick: () => restore(previous) },
      })
    } catch {
      toast.error(t('errors.unknown'))
    }
  }
}

/**
 * Именованные рабочие пространства (P0-E14 S06): сохранить текущие вкладки и
 * разделения под именем, открыть одним действием, перезаписать, удалить.
 */
export function WorkspacesMenu() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const layout = useWorkspace((s) => s.layout)
  const open = useOpenWorkspace()
  const [saving, setSaving] = useState(false)
  const { data: workspaces = [] } = useQuery(workspacesQuery())

  const refresh = () => void client.invalidateQueries({ queryKey: keys.workspaces })

  const overwrite = useMutation({
    mutationFn: (item: NamedWorkspaceSummary) =>
      http.patch(`/workspaces/${item.id}`, { layout: layout() }),
    onSuccess: (_result, item) => {
      toast.show({
        title: t('shell.workspaces.overwritten', { title: item.title }),
        tone: 'success',
      })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  const pin = useMutation({
    mutationFn: (item: NamedWorkspaceSummary) =>
      http.patch(`/workspaces/${item.id}`, { pinned: !item.pinned }),
    onSuccess: refresh,
    onError: () => toast.error(t('errors.forbidden')),
  })

  const remove = useMutation({
    mutationFn: (item: NamedWorkspaceSummary) => http.delete(`/objects/${item.id}`),
    onSuccess: (_result, item) => {
      toast.show({
        title: t('shell.workspaces.deleted', { title: item.title }),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => void http.post(`/objects/${item.id}/restore`).then(refresh),
        },
      })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  return (
    <>
      <DropdownMenu>
        <Tooltip content={t('shell.workspaces.menu')}>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('shell.workspaces.menu')} size="sm">
              <LayoutPanelLeft className="size-3.5" />
            </IconButton>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem icon={<Save className="size-4" />} onSelect={() => setSaving(true)}>
            {t('shell.workspaces.saveAs')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('shell.workspaces.menu')}</DropdownMenuLabel>
          {workspaces.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">{t('shell.workspaces.empty')}</p>
          ) : (
            workspaces.map((item) => (
              <DropdownMenuSub key={item.id}>
                <DropdownMenuSubTrigger>
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    {item.pinned ? <Pin className="size-3 shrink-0 text-fg-muted" /> : null}
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 text-2xs text-fg-muted">
                      {t('shell.workspaces.tabs', { count: item.tabCount })}
                    </span>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    icon={<LayoutPanelLeft className="size-4" />}
                    onSelect={() => void open(item)}
                  >
                    {t('shell.workspaces.open')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<Upload className="size-4" />}
                    onSelect={() => overwrite.mutate(item)}
                  >
                    {t('shell.workspaces.overwrite')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<Pin className="size-4" />}
                    onSelect={() => pin.mutate(item)}
                  >
                    {item.pinned ? t('shell.workspaces.unpin') : t('shell.workspaces.pin')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    danger
                    icon={<Trash2 className="size-4" />}
                    onSelect={() => remove.mutate(item)}
                  >
                    {t('common.actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveWorkspaceDialog
        open={saving}
        onOpenChange={setSaving}
        onSaved={(title) => {
          toast.show({ title: t('shell.workspaces.saved', { title }), tone: 'success' })
          refresh()
        }}
      />
    </>
  )
}

function SaveWorkspaceDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (title: string) => void
}) {
  const t = useT()
  const formId = useId()
  const layout = useWorkspace((s) => s.layout)
  const { data: spaces = [] } = useQuery(spacesQuery())
  const teamSpaces = spaces.filter((space) => space.kind !== 'personal')
  const [title, setTitle] = useState('')
  const [shared, setShared] = useState(false)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      http.post<NamedWorkspace>('/workspaces', {
        title: title.trim(),
        shared,
        spaceId: shared ? (spaceId ?? teamSpaces[0]?.id ?? null) : null,
        layout: layout(),
      }),
    onSuccess: (workspace) => {
      onSaved(workspace.title)
      onOpenChange(false)
      setTitle('')
      setShared(false)
      setError(null)
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.status === 403
          ? t('shell.workspaces.noRight')
          : err instanceof ApiError
            ? err.message
            : t('errors.unknown'),
      ),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('shell.workspaces.dialogTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!title.trim()}
              loading={save.isPending}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (title.trim()) save.mutate()
          }}
        >
          <Field
            label={t('shell.workspaces.name')}
            error={error ?? undefined}
            htmlFor={`${formId}-name`}
          >
            <Input
              id={`${formId}-name`}
              autoFocus
              maxLength={200}
              value={title}
              placeholder={t('shell.workspaces.namePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t('shell.workspaces.shared')}</p>
              <p className="text-xs text-fg-secondary">{t('shell.workspaces.sharedHint')}</p>
            </div>
            <Switch
              checked={shared}
              onCheckedChange={setShared}
              disabled={teamSpaces.length === 0}
              aria-label={t('shell.workspaces.shared')}
            />
          </div>
          {shared ? (
            <Field label={t('shell.workspaces.space')}>
              <Select
                value={spaceId ?? teamSpaces[0]?.id ?? ''}
                onValueChange={(next) => setSpaceId(next)}
              >
                <SelectTrigger aria-label={t('shell.workspaces.space')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teamSpaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}
