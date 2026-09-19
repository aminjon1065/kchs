import type { DocumentFromTemplateResult } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { templatesQuery } from './print/renders.js'
import { documentKeys, documentTypesQuery } from './queries.js'
import { errorText } from './status.js'

const NO_TEMPLATE = '__none__'

/**
 * «Создать» (03-screens.md §12): черновик документа по типу — служебная
 * записка, приказ, исходящее письмо — или по шаблону DOCX типа: карточка
 * заполняется из шаблона, первую версию строит движок (08-documents.md §8).
 * Входящие заводит канцелярия экраном регистрации.
 */
export function CreateDocumentDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const subjectId = useId()
  const { data: types = [] } = useQuery(documentTypesQuery())
  const creatable = types.filter((type) => type.direction !== 'incoming')
  const [typeId, setTypeId] = useState('')
  const [templateId, setTemplateId] = useState(NO_TEMPLATE)
  const [subject, setSubject] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const { data: templates = [] } = useQuery({
    ...templatesQuery(typeId || null),
    enabled: Boolean(typeId),
  })
  // Предлагаются только готовые шаблоны: файл загружен и разобран движком
  const usable = templates.filter((item) => item.file && item.inspectStatus === 'ready')

  useEffect(() => {
    if (!typeId && creatable[0]) {
      setTypeId((creatable.find((type) => type.key === 'memo') ?? creatable[0]).id)
    }
  }, [typeId, creatable])

  const create = useMutation({
    mutationFn: async () => {
      if (templateId !== NO_TEMPLATE) {
        return http.post<DocumentFromTemplateResult>('/documents/from-template', {
          templateId,
          typeId,
          ...(subject.trim() ? { subject: subject.trim() } : {}),
        })
      }
      return http.post<{ id: string }>('/documents', { typeId, subject: subject.trim() })
    },
    onSuccess: ({ id }) => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'document',
        title: subject.trim() || t('documents.draft'),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.create.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!typeId}
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
          <Field label={t('documents.fields.type')}>
            <Select
              value={typeId}
              onValueChange={(next) => {
                setTypeId(next)
                setTemplateId(NO_TEMPLATE)
              }}
            >
              <SelectTrigger aria-label={t('documents.fields.type')}>
                <SelectValue placeholder={t('documents.placeholders.choose')} />
              </SelectTrigger>
              <SelectContent>
                {creatable.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name[locale] ?? type.name.ru}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {usable.length > 0 ? (
            <Field label={t('documents.templates.pickForCreate')}>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger aria-label={t('documents.templates.pickForCreate')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEMPLATE}>{t('documents.templates.none')}</SelectItem>
                  {usable.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label={t('documents.fields.subject')} htmlFor={subjectId}>
            <Textarea
              id={subjectId}
              autoFocus
              rows={2}
              maxLength={1000}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>
          <p className="text-xs text-fg-muted">
            {templateId === NO_TEMPLATE
              ? t('documents.create.hint')
              : t('documents.templates.createHintDocument')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
