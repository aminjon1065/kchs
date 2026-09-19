import type { DocumentRecord, DocumentRenderRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  IconButton,
  ObjectIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, FileInput } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { documentKeys } from '../queries.js'
import { errorText } from '../status.js'
import { renderKeys, rendersQuery, templatesQuery, waitForRender } from './renders.js'

/**
 * Печатные формы и заполнения шаблонов документа (ADR-0085) во вкладке «Файлы
 * и версии»: готовые PDF открываются вкладкой, «По шаблону» заполняет шаблон
 * типа из текущей карточки — новая версия документа.
 */
export function RendersSection({ document }: { document: DocumentRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data: renders = [] } = useQuery(rendersQuery(document.id))

  const open = (render: DocumentRenderRecord) => {
    if (!render.file) return
    openTab({
      kind: 'object',
      objectId: render.file.id,
      objectType: 'file',
      title: render.file.name,
      mode: 'permanent',
    })
  }

  const label = (render: DocumentRenderRecord) =>
    render.labelKey ? t(render.labelKey) : (render.label ?? render.form ?? '')

  return (
    <section
      className="flex flex-col gap-2 border-t border-line pt-4"
      aria-label={t('documents.print.section')}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.print.section')}
      </h3>
      {document.can.addVersion ? <FillFromTemplate document={document} /> : null}
      {renders.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('documents.print.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {renders.map((render) => (
            <li key={render.id} className="flex items-center gap-2 text-xs">
              <ObjectIcon
                type={render.kind === 'fill' ? 'template' : 'file'}
                className="size-3.5 shrink-0 text-fg-muted"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg" title={label(render)}>
                  {render.kind === 'fill'
                    ? t('documents.print.filledFrom', { name: label(render) })
                    : label(render)}
                </span>
                <span className="block truncate text-2xs text-fg-muted">
                  {formatDateTime(render.createdAt, { locale })}
                  {render.requestedBy ? ` · ${render.requestedBy.displayName}` : ''}
                </span>
              </span>
              {render.status === 'ready' ? (
                render.file && render.kind === 'print' ? (
                  <Tooltip content={t('common.actions.open')}>
                    <IconButton
                      size="sm"
                      label={t('common.actions.open')}
                      onClick={() => open(render)}
                    >
                      <ExternalLink className="size-3.5" />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <Badge size="sm" tone="success">
                    {t('documents.print.status.ready')}
                  </Badge>
                )
              ) : render.status === 'failed' ? (
                <Badge size="sm" tone="danger" title={render.error ?? undefined}>
                  {t('documents.print.status.failed')}
                </Badge>
              ) : (
                <Spinner className="size-3.5" label={t('documents.print.status.running')} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function FillFromTemplate({ document }: { document: DocumentRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data: templates = [] } = useQuery(templatesQuery(document.type.id))
  const usable = templates.filter((item) => item.file && item.inspectStatus === 'ready')
  const [templateId, setTemplateId] = useState('')
  const chosen = usable.find((item) => item.id === templateId)?.id ?? usable[0]?.id ?? ''

  const fill = useMutation({
    mutationFn: async () => {
      const render = await http.post<DocumentRenderRecord>(`/documents/${document.id}/fill`, {
        templateId: chosen,
      })
      void client.invalidateQueries({ queryKey: renderKeys.renders(document.id) })
      return waitForRender(render.id)
    },
    onSuccess: (render) => {
      void client.invalidateQueries({ queryKey: renderKeys.renders(document.id) })
      void client.invalidateQueries({ queryKey: documentKeys.versions(document.id) })
      void client.invalidateQueries({ queryKey: documentKeys.document(document.id) })
      if (render.status === 'ready') {
        toast.show({ title: t('documents.templates.filled'), tone: 'success' })
      } else {
        toast.error(render.error ?? t('documents.templates.fillFailed'))
      }
    },
    onError: (error) => toast.error(errorText(error, t('documents.templates.fillFailed'))),
  })

  if (usable.length === 0) return null
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Select value={chosen} onValueChange={setTemplateId}>
          <SelectTrigger aria-label={t('documents.templates.pickForFill')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {usable.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<FileInput className="size-3.5" />}
        loading={fill.isPending}
        disabled={!chosen}
        onClick={() => fill.mutate()}
      >
        {t('documents.templates.fill')}
      </Button>
    </div>
  )
}
