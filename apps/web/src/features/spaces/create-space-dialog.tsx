import {
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { toSlug } from '~/shared/keys.js'

export function CreateSpaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)

  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [kind, setKind] = useState<'team' | 'org' | 'unit'>('team')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/spaces', {
        name: name.trim(),
        key: key || toSlug(name),
        kind,
        description: description.trim() || null,
      }),
    onSuccess: (result) => {
      toast.show({ title: t('spaces.create.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: keys.spaces })
      openTab({
        kind: 'screen',
        screen: 'space',
        title: name.trim(),
        icon: 'space',
        params: { spaceId: result.id },
        mode: 'permanent',
      })
      reset()
      onOpenChange(false)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const reset = (): void => {
    setName('')
    setKey('')
    setDescription('')
    setKind('team')
    setError(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent
        title={t('spaces.create.title')}
        description={t('spaces.create.hint')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          <Field label={t('spaces.create.name')} htmlFor="space-name" required>
            <Input
              id="space-name"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                if (!key) setKey('')
              }}
              placeholder={t('spaces.create.namePlaceholder')}
            />
          </Field>
          <Field
            label={t('spaces.create.key')}
            htmlFor="space-key"
            hint={t('spaces.create.keyHint')}
          >
            <Input
              id="space-key"
              value={key || toSlug(name)}
              onChange={(event) => setKey(toSlug(event.target.value))}
              mono
            />
          </Field>
          <Field label={t('spaces.create.kind')}>
            <Select value={kind} onValueChange={(next) => setKind(next as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">{t('spaces.kinds.team')}</SelectItem>
                <SelectItem value="unit">{t('spaces.kinds.unit')}</SelectItem>
                <SelectItem value="org">{t('spaces.kinds.org')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('common.labels.description')} htmlFor="space-description">
            <Textarea
              id="space-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('spaces.create.descriptionPlaceholder')}
              className="min-h-[60px]"
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
