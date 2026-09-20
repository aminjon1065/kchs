import type { FormPeriodOption, FormRecord, FormSubject, FormSubmission } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  SchemaForm,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardPen, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { formDutiesQuery, formKeys, formSchemaQuery, formsApi } from './queries.js'

/**
 * Заполнение сводки (ADR-0103): период выбирается из назначений смотрящего,
 * черновик сохраняется, сдача пишет строку датасета. Узкая колонка — экран
 * годится и для мобильного веба.
 */
export function FormFillTab({ form }: { form: FormRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()

  const { data: duties, isLoading } = useQuery(formDutiesQuery())
  const { data: schema } = useQuery(formSchemaQuery(form.id))
  const [periodKey, setPeriodKey] = useState('')
  const [submission, setSubmission] = useState<FormSubmission | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [comment, setComment] = useState('')

  const mine = (duties?.items ?? []).filter((item) => item.formId === form.id)
  const duty = mine[0]
  const periods: FormPeriodOption[] = duty?.periods ?? []
  const subject: FormSubject | null = duty?.subject ?? null

  useEffect(() => {
    if (!periodKey && periods.length > 0) setPeriodKey(periods[0]?.key ?? '')
  }, [periodKey, periods])

  const openSubmission = useMutation({
    mutationFn: (key: string) => {
      if (!subject) throw new Error('subject')
      return formsApi.open(form.id, key, subject)
    },
    onSuccess: (next) => {
      setSubmission(next)
      setValues(next.values)
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const saveDraft = useMutation({
    mutationFn: () => formsApi.save(submission?.id ?? '', values),
    onSuccess: (next) => {
      setSubmission(next)
      toast.success(t('forms.fill.saved'))
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const submit = useMutation({
    mutationFn: () => formsApi.submit(submission?.id ?? '', values),
    onSuccess: async (next) => {
      setSubmission(next)
      toast.success(t('forms.fill.submitted'))
      await client.invalidateQueries({ queryKey: formKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const review = useMutation({
    mutationFn: (decision: 'accept' | 'return') =>
      formsApi.review(submission?.id ?? '', { decision, comment: comment || null }),
    onSuccess: async (next) => {
      setSubmission(next)
      setComment('')
      toast.success(
        next.status === 'accepted' ? t('forms.review.accepted') : t('forms.review.returned'),
      )
      await client.invalidateQueries({ queryKey: formKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (!duty || !subject) {
    return (
      <EmptyState
        icon={<ClipboardPen className="size-5" />}
        title={t('forms.fill.notAssigned')}
        description={t('forms.fill.notAssignedHint')}
      />
    )
  }

  const selected = periods.find((period) => period.key === periodKey)
  const fields = schema?.fields ?? []

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('forms.fill.period')} className="min-w-[200px] flex-1">
          <Select value={periodKey} onValueChange={setPeriodKey}>
            <SelectTrigger aria-label={t('forms.fill.period')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods.map((period) => (
                <SelectItem key={period.key} value={period.key}>
                  {period.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button
          variant="secondary"
          loading={openSubmission.isPending}
          disabled={periodKey.length === 0}
          onClick={() => openSubmission.mutate(periodKey)}
        >
          {t('forms.fill.open')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>{duty.subjectName ?? ''}</span>
        {selected?.dueAt ? (
          <span>{t('forms.fill.dueAt', { when: formatDateTime(selected.dueAt, { locale }) })}</span>
        ) : null}
        {selected ? (
          <Badge tone={selected.state === 'accepted' ? 'success' : 'neutral'} size="sm">
            {t(`forms.states.${selected.state}`)}
          </Badge>
        ) : null}
      </div>

      {!submission ? (
        <EmptyState
          compact
          icon={<ClipboardPen className="size-5" />}
          title={t('forms.fill.pickPeriod')}
          description={t('forms.fill.pickPeriodHint')}
        />
      ) : (
        <>
          {submission.status === 'returned' && submission.comment ? (
            <Callout tone="warning" title={t('forms.fill.returned')}>
              {submission.comment}
            </Callout>
          ) : null}
          {submission.canSubmit ? (
            <SchemaForm
              schema={{ fields }}
              values={values}
              onChange={setValues}
              onSubmit={() => submit.mutate()}
              submitLabel={t('forms.fill.submit')}
            />
          ) : (
            <Callout tone="info" title={t(`forms.states.${submission.status}`)}>
              {t('forms.fill.readOnly')}
            </Callout>
          )}
          {submission.canSubmit ? (
            <div className="flex flex-wrap gap-2">
              {/* Сдача — кнопка самой формы: она отправляет только корректные значения */}
              <Button
                variant="secondary"
                icon={<Save className="size-4" />}
                loading={saveDraft.isPending}
                onClick={() => saveDraft.mutate()}
              >
                {t('forms.fill.saveDraft')}
              </Button>
            </div>
          ) : null}

          {submission.canReview ? (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
              <span className="text-sm font-medium">{t('forms.review.title')}</span>
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
        </>
      )}
    </div>
  )
}
