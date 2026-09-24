import type { FieldDef, FormRecord } from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  KeyValueList,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { useFieldFormatter } from '../data/field-controls.js'
import { formKeys, formSchemaQuery, formSubmissionQuery, formsApi } from './queries.js'

const NO_FIELDS: FieldDef[] = []
const NO_ROWS: Array<Record<string, unknown>> = []

/**
 * Сводка из матрицы контроля (ADR-0103, ADR-0129): значения как их сдали — у
 * табличной формы строки — и приёмка: принять или вернуть с комментарием.
 * Ответственному за приёмку не нужно быть назначенным, поэтому экран
 * заполнения ему не подходит.
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
  const fields = schema?.fields ?? NO_FIELDS
  const table = form.definition.layout === 'table'
  const rows = submission?.rows ?? NO_ROWS
  const records = useMemo(
    () => (table ? rows : submission ? [submission.values] : NO_ROWS),
    [table, rows, submission],
  )
  const format = useFieldFormatter(fields, records)

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

  const labelOf = (field: FieldDef) => field.label[locale] ?? field.label.ru
  const items = fields.map((field) => ({
    key: field.key,
    label: labelOf(field),
    value: format(field, submission.values[field.key]) || '—',
  }))

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{submission.subjectName ?? ''}</span>
        <span className="text-xs text-fg-muted">{submission.periodKey}</span>
        <Badge tone={submission.status === 'accepted' ? 'success' : 'neutral'} size="sm">
          {t(`forms.states.${submission.status}`)}
        </Badge>
        {table && submission.submittedAt ? (
          <Badge tone="neutral" size="sm">
            {t('forms.table.rowsCount', { count: submission.rowIds.length })}
          </Badge>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
      </div>

      {table ? (
        rows.length === 0 ? (
          <EmptyState compact title={t('forms.table.noRows')} />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-max text-sm" aria-label={t('forms.table.title')}>
              <thead>
                <tr className="border-b border-line bg-surface-2 text-xs text-fg-muted">
                  <th scope="col" className="w-10 px-2 py-2 text-right font-medium">
                    {t('forms.table.number')}
                  </th>
                  {fields.map((field) => (
                    <th key={field.key} scope="col" className="px-2 py-2 text-left font-medium">
                      {labelOf(field)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  // Строки сданной сводки не меняются: номер строки — устойчивый ключ
                  <tr key={index} className="border-b border-line last:border-0">
                    <th scope="row" className="px-2 py-1.5 text-right font-normal text-fg-muted">
                      {index + 1}
                    </th>
                    {fields.map((field) => (
                      <td key={field.key} className="px-2 py-1.5 text-fg">
                        {format(field, row[field.key]) || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : items.length > 0 ? (
        <KeyValueList items={items} columns={2} />
      ) : null}

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
