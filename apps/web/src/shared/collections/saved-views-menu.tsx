import type { SavedView } from '@kchs/contracts'
import {
  Button,
  type CollectionState,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { fromDefinition, sameState, toDefinition } from './collection-state.js'

/**
 * Сохранённые представления списка (03-ui/04-interaction-patterns.md §2):
 * личные и общие для пространства; изменённое общее — «Изменено · Сохранить/Сбросить».
 */
export function SavedViewsMenu({
  objectType,
  spaceId,
  state,
  activeViewId,
  onApply,
}: {
  objectType: string
  spaceId?: string
  state: CollectionState
  activeViewId: string | null
  onApply: (viewId: string | null, state: CollectionState) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [saveOpen, setSaveOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [shared, setShared] = useState(false)

  const queryKey = ['views', objectType, spaceId ?? null]
  const { data: views = [] } = useQuery({
    queryKey,
    queryFn: () => http.get<{ items: SavedView[] }>('/views', { query: { objectType, spaceId } }),
    select: (data) => data.items,
  })
  const active = views.find((view) => view.id === activeViewId) ?? null
  const modified = active ? !sameState(fromDefinition(active.definition), state) : false

  const create = useMutation({
    mutationFn: () =>
      http.post<SavedView>('/views', {
        title: title.trim(),
        objectType,
        shared,
        spaceId: shared ? spaceId : undefined,
        definition: toDefinition(state),
      }),
    onSuccess: (view) => {
      setSaveOpen(false)
      setTitle('')
      void client.invalidateQueries({ queryKey })
      onApply(view.id, fromDefinition(view.definition))
      toast.show({ title: view.title, tone: 'success' })
    },
    onError: () => toast.error(t('errors.unknown')),
  })

  const update = useMutation({
    mutationFn: (id: string) =>
      http.patch<SavedView>(`/views/${id}`, { definition: toDefinition(state) }),
    onSuccess: () => void client.invalidateQueries({ queryKey }),
  })

  return (
    <>
      {active && modified ? (
        <span className="flex items-center gap-1 text-xs text-fg-muted">
          {t('ui.collection.modified')}
          <Button variant="ghost" size="sm" onClick={() => update.mutate(active.id)}>
            {t('ui.collection.save')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onApply(active.id, fromDefinition(active.definition))}
          >
            {t('ui.collection.reset')}
          </Button>
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" icon={<Bookmark className="size-3.5" />}>
            {active?.title ?? t('ui.collection.views')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {views.length === 0 ? (
            <DropdownMenuLabel>{t('ui.collection.noViews')}</DropdownMenuLabel>
          ) : (
            (['personal', 'team'] as const).map((group) => {
              const items = views.filter((view) => (group === 'team') === view.shared)
              if (items.length === 0) return null
              return (
                <div key={group}>
                  <DropdownMenuLabel>{t(`ui.collection.${group}`)}</DropdownMenuLabel>
                  {items.map((view) => (
                    <DropdownMenuItem
                      key={view.id}
                      onSelect={() => onApply(view.id, fromDefinition(view.definition))}
                      icon={
                        view.id === activeViewId ? (
                          <Check className="size-3.5" />
                        ) : (
                          <span className="size-3.5" />
                        )
                      }
                    >
                      {view.title}
                    </DropdownMenuItem>
                  ))}
                </div>
              )
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
            {active ? t('ui.collection.saveAs') : t('ui.collection.saveView')}
          </DropdownMenuItem>
          {active ? (
            <DropdownMenuItem onSelect={() => onApply(null, state)}>
              {t('ui.collection.reset')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent title={t('ui.collection.saveView')}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (title.trim()) create.mutate()
            }}
          >
            <Field label={t('ui.collection.viewTitle')} htmlFor="view-title">
              <Input
                id="view-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                required
              />
            </Field>
            {spaceId ? (
              <Switch
                label={t('ui.collection.shared')}
                checked={shared}
                onCheckedChange={setShared}
              />
            ) : null}
            <Button type="submit" variant="primary" loading={create.isPending}>
              {t('ui.collection.save')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
