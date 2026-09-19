import { Button, Callout, Dialog, DialogContent, Field, Input, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Новый отчёт в пространстве (06-analytics-engine.md §12): с пустым текстовым
 * блоком — можно сразу писать; открывается во вкладке.
 */
export function CreateReportDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/reports', {
        name: name.trim(),
        spaceId,
        blocks: [{ id: 'intro', kind: 'text' }],
      }),
    onSuccess: ({ id }) => {
      toast.show({ title: t('data.report.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'report',
        title: name.trim(),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.report.createTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
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
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.report.name')}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) create.mutate()
              }}
              aria-label={t('data.report.name')}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
