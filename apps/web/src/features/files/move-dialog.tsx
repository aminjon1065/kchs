import type { ObjectSummary } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  ObjectIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tree,
  type TreeNode,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'

/** Корень пространства в дереве выбора: папки без родителя. */
const ROOT = '__root'

/** Переносимый объект: файл или папка списка. */
export type Movable = Pick<ObjectSummary, 'id' | 'type' | 'title' | 'spaceId'> & {
  parentId?: string | null
}

/**
 * Перенести объекты в другую папку или пространство. Перемещение файлов и папок
 * — PATCH объекта с новым родителем: сервер проверяет право на сам объект и право
 * создавать в папке-цели (ADR-0151). Дерево папок подгружается по мере раскрытия.
 * Нельзя положить папку в неё саму и в её ветку — такие узлы в дереве не показаны.
 */
export async function moveObjects(
  items: readonly Movable[],
  target: { spaceId: string; parentId: string | null },
): Promise<{ moved: number; failed: Array<{ title: string; reason: string }> }> {
  let moved = 0
  const failed: Array<{ title: string; reason: string }> = []
  for (const item of items) {
    if (item.id === target.parentId) continue
    try {
      await http.patch(`/objects/${item.id}`, {
        parentId: target.parentId,
        ...(item.spaceId !== target.spaceId ? { spaceId: target.spaceId } : {}),
      })
      moved += 1
    } catch (error) {
      failed.push({
        title: item.title,
        reason: error instanceof ApiError ? error.message : String(error),
      })
    }
  }
  return { moved, failed }
}

export function MoveDialog({
  items,
  spaceId,
  excludeFolderId,
  onClose,
}: {
  items: readonly Movable[]
  spaceId: string
  /** Папка, куда класть нельзя (системная «Вложения»). */
  excludeFolderId?: string | null
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  // В архивное пространство не переносят: оно только для чтения (ADR-0152)
  const { data: allSpaces = [] } = useQuery(spacesQuery())
  const spaces = allSpaces.filter((item) => !item.archivedAt)
  const [targetSpace, setTargetSpace] = useState(spaceId)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]))
  const [target, setTarget] = useState<string>(ROOT)
  const [failed, setFailed] = useState<Array<{ title: string; reason: string }>>([])

  const parents = useMemo(() => [ROOT, ...[...expanded].filter((id) => id !== ROOT)], [expanded])
  const levels = useQueries({
    queries: parents.map((parent) =>
      objectListQuery({
        types: 'folder',
        spaceId: targetSpace,
        parentId: parent === ROOT ? 'root' : parent,
        limit: 200,
      }),
    ),
  })
  const childrenOf = new Map(parents.map((parent, index) => [parent, levels[index]?.data?.items]))
  // Папку нельзя класть в неё саму и в её ветку: переносимые папки в дереве не видны
  const blocked = new Set([
    ...items.filter((item) => item.type === 'folder').map((item) => item.id),
    ...(excludeFolderId ? [excludeFolderId] : []),
  ])

  const build = (parent: string): TreeNode[] =>
    (childrenOf.get(parent) ?? [])
      .filter((folder) => !blocked.has(folder.id))
      .map((folder) => ({
        id: folder.id,
        label: folder.title,
        icon: <ObjectIcon type="folder" className="text-fg-muted" />,
        hasChildren: true,
        children: expanded.has(folder.id) ? build(folder.id) : undefined,
      }))

  const space = spaces.find((item) => item.id === targetSpace)
  const nodes: TreeNode[] = [
    {
      id: ROOT,
      label: space?.name ?? t('files.move.root'),
      icon: <ObjectIcon type="space" className="text-fg-muted" />,
      hasChildren: true,
      children: build(ROOT),
    },
  ]

  const move = useMutation({
    mutationFn: () =>
      moveObjects(items, { spaceId: targetSpace, parentId: target === ROOT ? null : target }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      if (result.failed.length > 0) {
        setFailed(result.failed)
        if (result.moved > 0) {
          toast.show({ title: t('files.move.moved', { count: result.moved }), tone: 'success' })
        }
        return
      }
      toast.show({ title: t('files.move.moved', { count: result.moved }), tone: 'success' })
      onClose()
    },
    onError: (error) =>
      setFailed([{ title: '', reason: error instanceof Error ? error.message : String(error) }]),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('files.move.title', { count: items.length })}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={move.isPending} onClick={() => move.mutate()}>
              {t('files.move.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failed.length > 0 ? (
            <Callout tone="danger" title={t('files.move.failed', { count: failed.length })}>
              <ul className="list-disc pl-4">
                {failed.map((item) => (
                  <li key={`${item.title}-${item.reason}`}>
                    {item.title ? `${item.title}: ` : ''}
                    {item.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {spaces.length > 1 ? (
            <Field label={t('files.move.space')}>
              <Select
                value={targetSpace}
                onValueChange={(next) => {
                  setTargetSpace(next)
                  setTarget(ROOT)
                  setExpanded(new Set([ROOT]))
                }}
              >
                <SelectTrigger aria-label={t('files.move.space')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {orderSpaces(spaces).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <p className="text-xs text-fg-secondary">{t('files.move.hint')}</p>
          <div className="max-h-72 overflow-y-auto rounded-md border border-line p-1">
            <Tree
              nodes={nodes}
              selectedId={target}
              expandedIds={expanded}
              onToggle={(id) =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onSelect={(node) => setTarget(node.id)}
              onActivate={(node) => {
                setTarget(node.id)
                move.mutate()
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Переименовать файл или папку: название объекта — оно же имя файла. */
export function RenameDialog({ item, onClose }: { item: Movable; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const inputId = useId()
  const [title, setTitle] = useState(item.title)
  const [error, setError] = useState<string | null>(null)
  const rename = useMutation({
    mutationFn: () => http.patch(`/objects/${item.id}`, { title: title.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: ['object', item.id] })
      void client.invalidateQueries({ queryKey: ['file', item.id] })
      toast.show({ title: t('files.rename.done'), tone: 'success' })
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })
  const valid = title.trim().length > 0 && title.trim() !== item.title

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t(item.type === 'folder' ? 'files.rename.folderTitle' : 'files.rename.fileTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={rename.isPending}
              onClick={() => rename.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('common.labels.name')} htmlFor={inputId}>
            <Input
              id={inputId}
              autoFocus
              value={title}
              maxLength={255}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && valid) rename.mutate()
              }}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
