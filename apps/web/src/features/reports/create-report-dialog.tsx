import type { ReportTemplate } from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Card,
  cn,
  Dialog,
  DialogContent,
  Field,
  Input,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { reportTemplatesQuery } from './queries.js'

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
  const [template, setTemplate] = useState<ReportTemplate | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { data: templates = [] } = useQuery(reportTemplatesQuery())
  // Подписи встроенных шаблонов — из словарей: на языке интерфейса
  const templateName = (item: ReportTemplate) =>
    item.key ? t(`data.report.templates.builtin.${item.key}.name`) : item.name
  const templateHint = (item: ReportTemplate) =>
    item.key ? t(`data.report.templates.builtin.${item.key}.description`) : item.description
  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/reports', {
        name: name.trim(),
        spaceId,
        ...(template
          ? { blocks: template.blocks, params: template.params, settings: template.settings }
          : { blocks: [{ id: 'intro', kind: 'text' }] }),
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
        size="md"
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
          <Field label={t('data.report.templates.title')}>
            <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {[null, ...templates].map((item) => {
                const selected = (template?.id ?? null) === (item?.id ?? null)
                return (
                  <Card
                    key={item?.id ?? 'blank'}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    className={cn(
                      'cursor-pointer p-3 transition-colors',
                      selected && 'border-accent',
                    )}
                    onClick={() => {
                      setTemplate(item)
                      if (item && !name.trim()) setName(templateName(item))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setTemplate(item)
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-fg">
                        {item ? templateName(item) : t('data.report.templates.blank')}
                      </span>
                      {item?.source === 'report' ? (
                        <Badge tone="neutral">{t('data.report.templates.own')}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-fg-secondary">
                      {item ? templateHint(item) : t('data.report.templates.blankHint')}
                    </p>
                  </Card>
                )
              })}
            </div>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
