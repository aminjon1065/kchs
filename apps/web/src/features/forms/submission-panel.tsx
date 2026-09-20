import type { FieldDef, FormRecord } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { Badge, Button, Callout, KeyValueList, Skeleton, Textarea, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { formKeys, formSchemaQuery, formSubmissionQuery, formsApi } from './queries.js'

/**
 * Сводка из матрицы контроля (ADR-0103): значения как их сдали и приёмка —
 * принять или вернуть с комментарием. Ответственному за приёмку не нужно быть
 * назначенным, поэтому экран заполнения ему не подходит.
 */
export function SubmissionPanel({
  form,
  submissionId,
  onClose,
}: {
  form: FormRecord
  submissionId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const [comment, setComment] = useState('')

  const { data: submission, isLoading } = useQuery(formSubmissionQuery(submissionId))
  const { data: schema } = useQuery(formSchemaQuery(form.id))

  const review = useMutation({
    mutationFn: (decision: 'accept' | 'return') =>
      formsApi.review(submissionId, { decision, comment: comment || null }),
    onSuccess: async (next) => {
      setComment('')
      toast.success(
        next.status === 'accepted' ? t('forms.review.accepted') : t('forms.review.returned'),
      )
      await client.invalidateQueries({ queryKey: formKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (isLoading || !submission) return <Skeleton className="h-32 w-full" />

  const fields: FieldDef[] = schema?.fields ?? []
  const items = fields.map((field) => ({
    key: field.key,
    label: field.label.ru,
    value: formatValue(submission.values[field.key], field, { locale }) || '—',
  }))

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{submission.subjectName ?? ''}</span>
        <span className="text-xs text-fg-muted">{submission.periodKey}</span>
        <Badge tone={submission.status === 'accepted' ? 'success' : 'neutral'} size="sm">
          {t(`forms.states.${submission.status}`)}
        </Badge>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
      </div>

      {items.length > 0 ? <KeyValueList items={items} columns={2} /> : null}

      {submission.comment ? (
        <Callout tone="warning" title={t('forms.review.comment')}>
          {submission.comment}
        </Callout>
      ) : null}

      {submission.canReview ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={comment}
            aria-label={t('forms.review.comment')}
            placeholder={t('forms.review.commentPlaceholder')}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              loading={review.isPending}
              onClick={() => review.mutate('accept')}
            >
              {t('forms.review.accept')}
            </Button>
            <Button
              variant="secondary"
              disabled={comment.trim().length === 0}
              loading={review.isPending}
              onClick={() => review.mutate('return')}
            >
              {t('forms.review.return')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
