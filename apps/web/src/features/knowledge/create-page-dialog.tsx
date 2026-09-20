import { PAGE_TEMPLATES, type PageTemplate } from '@kchs/contracts'
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
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Новая страница базы знаний (ADR-0095): название, шаблон (инструкция,
 * регламент, справочник, FAQ) и родитель. Блоки шаблона сразу в документе —
 * страница открывается уже с заготовкой.
 */
export function CreatePageDialog({
  spaceId,
  parentId,
  onClose,
}: {
  spaceId: string
  parentId: string | null
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const titleId = useId()
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState<PageTemplate>('blank')

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/pages', {
        title: title.trim(),
        spaceId,
        template,
        ...(parentId ? { parentId } : {}),
      }),
    onSuccess: (created) => {
      toast.show({ title: t('knowledge.create.done'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['knowledge', 'tree'] })
      openTab({
        kind: 'object',
        objectId: created.id,
        objectType: 'page',
        title: title.trim(),
        mode: 'permanent',
      })
      onClose()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('knowledge.create.title')}>
        <div className="flex flex-col gap-3">
          <Field label={t('knowledge.create.name')} htmlFor={titleId}>
            <Input
              id={titleId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('knowledge.create.namePlaceholder')}
              autoFocus
            />
          </Field>
          <Field label={t('knowledge.create.template')}>
            <Select value={template} onValueChange={(next) => setTemplate(next as PageTemplate)}>
              <SelectTrigger aria-label={t('knowledge.create.template')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_TEMPLATES.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key === 'blank'
                      ? t('knowledge.templates.blank')
                      : t(`knowledge.templates.${key}.name`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-2xs text-fg-muted">
            {parentId ? t('knowledge.create.parent') : t('knowledge.create.parentRoot')}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || title.trim().length === 0}
            >
              {t('knowledge.create.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
