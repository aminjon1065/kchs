import type { Locale, Position } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  AlertDialog,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

const positionsKey = ['org', 'positions'] as const

/** Должности от старших к младшим: ранг — старшинство (у председателя больше). */
export const positionsQuery = () => ({
  queryKey: positionsKey,
  queryFn: async () =>
    (await http.get<{ items: Position[] }>('/org/positions')).items.sort((a, b) => b.rank - a.rank),
})

/**
 * Справочник должностей (N86): название на трёх языках и ранг — порядок в списках
 * (председатель выше специалиста). Занятую должность не удалить — сначала
 * переназначьте сотрудников.
 */
export function PositionsCard() {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const toast = useToast()
  const client = useQueryClient()
  const { data: items = [], isLoading } = useQuery(positionsQuery())
  const [editing, setEditing] = useState<Position | 'new' | null>(null)
  const [removing, setRemoving] = useState<Position | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => http.delete(`/org/positions/${id}`),
    onSuccess: () => {
      setRemoving(null)
      toast.show({ title: t('admin.positions.removed'), tone: 'info' })
      void client.invalidateQueries({ queryKey: positionsKey })
    },
    onError: (err) => {
      setRemoving(null)
      toast.error(err instanceof ApiError ? err.message : t('errors.unknown'))
    },
  })

  return (
    <Card
      title={t('admin.positions.title')}
      padded={false}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEditing('new')}
        >
          {t('admin.positions.create')}
        </Button>
      }
    >
      {!isLoading && items.length === 0 ? (
        <EmptyState compact title={t('admin.positions.empty')} />
      ) : (
        <ul className="divide-y divide-line" aria-label={t('admin.positions.title')}>
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-fg">
                {localizedText(item.name, locale)}
              </span>
              <span className="tabular shrink-0 text-xs text-fg-muted">
                {t('admin.positions.rankValue', { rank: item.rank })}
              </span>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('admin.positions.edit', { name: localizedText(item.name, locale) })}
                onClick={() => setEditing(item)}
              >
                <Pencil className="size-3.5" />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('admin.positions.remove', { name: localizedText(item.name, locale) })}
                onClick={() => setRemoving(item)}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <PositionDialog
          position={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={t('admin.positions.removeTitle', {
          name: removing ? localizedText(removing.name, locale) : '',
        })}
        description={t('admin.positions.removeHint')}
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </Card>
  )
}

function PositionDialog({ position, onClose }: { position: Position | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [form, setForm] = useState({
    ru: position?.name.ru ?? '',
    tg: position?.name.tg ?? '',
    en: position?.name.en ?? '',
    rank: String(position?.rank ?? 0),
  })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: {
          ru: form.ru.trim(),
          ...(form.tg.trim() ? { tg: form.tg.trim() } : {}),
          ...(form.en.trim() ? { en: form.en.trim() } : {}),
        },
        rank: Number.parseInt(form.rank, 10) || 0,
      }
      return position
        ? http.patch(`/org/positions/${position.id}`, body)
        : http.post('/org/positions', body)
    },
    onSuccess: () => {
      toast.show({ title: t('admin.positions.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: positionsKey })
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={position ? t('admin.positions.editTitle') : t('admin.positions.create')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={form.ru.trim().length === 0}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.org.fields.nameRu')} required htmlFor={`${formId}-ru`}>
            <Input
              id={`${formId}-ru`}
              value={form.ru}
              onChange={(e) => set({ ru: e.target.value })}
            />
          </Field>
          <Field label={t('admin.org.fields.nameTg')} htmlFor={`${formId}-tg`}>
            <Input
              id={`${formId}-tg`}
              value={form.tg}
              onChange={(e) => set({ tg: e.target.value })}
            />
          </Field>
          <Field label={t('admin.org.fields.nameEn')} htmlFor={`${formId}-en`}>
            <Input
              id={`${formId}-en`}
              value={form.en}
              onChange={(e) => set({ en: e.target.value })}
            />
          </Field>
          <Field
            label={t('admin.positions.rank')}
            hint={t('admin.positions.rankHint')}
            htmlFor={`${formId}-rank`}
          >
            <Input
              id={`${formId}-rank`}
              type="number"
              value={form.rank}
              onChange={(e) => set({ rank: e.target.value })}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
