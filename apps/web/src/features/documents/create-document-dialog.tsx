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
import { documentKeys, documentTypesQuery } from './queries.js'
import { errorText } from './status.js'

/**
 * «Создать» (03-screens.md §12): черновик документа по типу — служебная
 * записка, приказ, исходящее письмо; карточка открывается во вкладке.
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
  const [subject, setSubject] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!typeId && creatable[0]) {
      setTypeId((creatable.find((type) => type.key === 'memo') ?? creatable[0]).id)
    }
  }, [typeId, creatable])

  const create = useMutation({
    mutationFn: () => http.post<{ id: string }>('/documents', { typeId, subject: subject.trim() }),
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
            <Select value={typeId} onValueChange={setTypeId}>
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
          <p className="text-xs text-fg-muted">{t('documents.create.hint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
