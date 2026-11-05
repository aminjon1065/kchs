import type { WarningLanguage, WarningRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import type { ProcessInstanceView, ProcessMyAction, ProcessStepView } from '@kchs/process'
import {
  Button,
  CodeInput,
  cn,
  Dialog,
  DialogContent,
  Field,
  HazardMark,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, Route, Send, ShieldCheck, Undo2, X } from 'lucide-react'
import { Suspense, useId, useState } from 'react'
import {
  ObjectRoutePanel,
  objectProcessesQuery,
  processApi,
  processKeys,
  processQuery,
} from '~/features/processes/index.js'
import { ApiError } from '~/shared/api/errors.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { HAZARD_LEVEL } from './labels.js'
import { minutesLeft, warningChecks } from './warning-checks.js'
import type { WarningDraft } from './warning-form.js'

/** Цифр в коде приложения-аутентификатора: подпись подтверждается только TOTP (ADR-0079). */
const CODE_LENGTH = 6

// Полные строки классов: Tailwind собирает только то, что видит в исходнике целиком
const LEVEL_TEXT = {
  0: 'text-hazard-0-text',
  1: 'text-hazard-1-text',
  2: 'text-hazard-2-text',
  3: 'text-hazard-3-text',
} as const

type StepState = 'done' | 'current' | 'refused' | 'pending'

/** Шаг линии решения: точка состояния и две строки — кто и когда. */
function DecisionStep({
  state,
  title,
  hint,
  last,
}: {
  state: StepState
  title: string
  hint: string | null
  last?: boolean
}) {
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5">
      <div className="flex flex-col items-center">
        {state === 'done' ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-success text-fg-inverse">
            <Check className="size-2.5" strokeWidth={4} aria-hidden />
          </span>
        ) : state === 'refused' ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-danger text-danger-fg">
            <X className="size-2.5" strokeWidth={4} aria-hidden />
          </span>
        ) : (
          <span
            className={cn(
              'size-4 rounded-full border-2 bg-surface',
              state === 'current'
                ? 'border-accent ring-3 ring-accent-subtle'
                : 'border-line-strong',
            )}
          />
        )}
        {last ? null : (
          <span
            className={cn('w-0.5 flex-1', state === 'done' ? 'bg-success' : 'bg-line')}
            aria-hidden
          />
        )}
      </div>
      <div className={cn('flex flex-col', last ? null : 'pb-3')}>
        <span
          className={cn(
            'text-sm',
            state === 'current' ? 'font-semibold text-accent' : 'font-medium text-fg',
          )}
        >
          {title}
        </span>
        {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </div>
    </li>
  )
}

function lastSignStep(view: ProcessInstanceView | undefined): ProcessStepView | null {
  if (!view) return null
  const signs = view.steps.filter((step) => step.type === 'sign')
  return signs.find((step) => step.status === 'active') ?? signs.at(-1) ?? null
}

/**
 * Панель «Решение руководства штаба» (ADR-0202, ADR-0230): линия «подготовил →
 * решение» по маршруту выпуска, проверка перед подписью, предпросмотр для получателей
 * на выбранном языке и решение подписью с кодом второго фактора. Решение — то же API
 * движка, что у вкладки маршрута; передача шага и весь ход маршрута — в «Маршрут
 * полностью».
 */
export function WarningDecisionPanel({
  warning,
  draft,
  language,
  onSubmit,
  submitting,
  onChanged,
  className,
}: {
  warning: WarningRecord
  draft: WarningDraft
  language: WarningLanguage
  onSubmit: () => void
  submitting: boolean
  onChanged: () => void
  className?: string
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const codeId = useId()
  const commentId = useId()
  const [code, setCode] = useState('')
  const [returning, setReturning] = useState(false)
  const [comment, setComment] = useState('')
  const [routeOpen, setRouteOpen] = useState(false)
  const { data: me } = useQuery(meQuery())
  const processes = useQuery(objectProcessesQuery(warning.id))
  const latest = [...(processes.data ?? [])].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  )[0]
  const view = useQuery({
    ...processQuery(warning.id, latest?.id ?? ''),
    enabled: Boolean(latest),
  })
  const route = view.data
  const step = lastSignStep(route)
  const action: ProcessMyAction | undefined = route?.myActions.find(
    (item) => item.stepId === step?.id && item.actions.includes('sign'),
  )
  const isDraft = warning.status === 'draft'
  const level = HAZARD_LEVEL[draft.severity]
  const dateOf = (value: string) => formatDateTime(value, { locale })
  const languageName = (value: WarningLanguage) => t(`warnings.languages.${value}`)

  const refresh = () => {
    if (latest)
      void client.invalidateQueries({ queryKey: processKeys.instance(warning.id, latest.id) })
    void client.invalidateQueries({ queryKey: processKeys.list(warning.id) })
    void client.invalidateQueries({ queryKey: keys.object(warning.id) })
    void client.invalidateQueries({ queryKey: ['inbox'] })
    void client.invalidateQueries({ queryKey: keys.inboxCounts })
    onChanged()
  }
  const failed = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))

  const decide = useMutation({
    mutationFn: (input: { action: 'sign' | 'refuse'; code?: string; comment?: string }) => {
      if (!route || !step || !action) throw new Error(t('errors.unknown'))
      return processApi.act(
        route.id,
        step.id,
        {
          action: input.action,
          ...(input.code ? { code: input.code } : {}),
          ...(input.comment ? { comment: input.comment } : {}),
        },
        action.onBehalfOf?.id ?? null,
      )
    },
    onSuccess: () => {
      toast.success(t('warnings.decision.done'))
      setCode('')
      setComment('')
      setReturning(false)
      refresh()
    },
    onError: (error) => {
      setCode('')
      failed(error)
    },
  })

  // ── Время до срока решения ───────────────────────────────────────────────
  const left = step?.status === 'active' ? minutesLeft(step.dueAt) : null
  const span = (minutes: number) =>
    minutes < 60
      ? t('warnings.decision.minutes', { count: minutes })
      : t('warnings.decision.hoursMinutes', {
          hours: Math.floor(minutes / 60),
          minutes: String(minutes % 60).padStart(2, '0'),
        })
  const leftText =
    left === null
      ? null
      : left < 0
        ? t('warnings.decision.overdue', { time: span(-left) })
        : span(left)

  // ── Линия решения ────────────────────────────────────────────────────────
  const author = route?.startedBy ?? warning.author
  const assignees = step?.assignees ?? []
  const meAssigned = assignees.some((item) => item.user.id === me?.user.id)
  const names = assignees.length
    ? assignees
        .map((item) =>
          item.user.id === me?.user.id
            ? `${item.user.displayName}, ${t('warnings.decision.you')}`
            : item.user.displayName,
        )
        .join('; ')
    : (warning.signer?.displayName ?? t('warnings.decision.noSigner'))
  const dueHours =
    step?.dueAt && step.activatedAt
      ? Math.max(
          1,
          Math.round(
            (new Date(step.dueAt).getTime() - new Date(step.activatedAt).getTime()) / 3_600_000,
          ),
        )
      : null
  const decided = assignees.find((item) => item.decidedAt)
  const decidedName = decided ? (decided.actor ?? decided.user).displayName : null
  const refused =
    step?.status !== 'active' && (step?.outcome === 'refused' || step?.outcome === 'rejected')
  const signed = step?.status === 'completed' && !refused

  const preparedTitle = isDraft
    ? t('warnings.decision.preparing', { name: author?.displayName ?? '—' })
    : t('warnings.decision.prepared', { name: author?.displayName ?? '—' })
  const preparedHint =
    !isDraft && route
      ? t('warnings.decision.submittedAt', { date: dateOf(route.startedAt) })
      : t('warnings.decision.draftHint')
  const decisionState: StepState = isDraft
    ? refused
      ? 'refused'
      : 'pending'
    : signed
      ? 'done'
      : refused
        ? 'refused'
        : 'current'
  const decisionHint =
    signed && decidedName && decided?.decidedAt
      ? t('warnings.decision.signed', { name: decidedName, date: dateOf(decided.decidedAt) })
      : refused && decidedName && decided?.decidedAt
        ? t('warnings.decision.refused', { name: decidedName, date: dateOf(decided.decidedAt) })
        : dueHours
          ? t('warnings.decision.stepHint', { hours: dueHours })
          : t('warnings.decision.stepHintNoDue')

  // ── Проверка перед подписью ──────────────────────────────────────────────
  const result = warningChecks(draft)
  const checkText = (key: string): string => {
    switch (key) {
      case 'languages':
        return result.missingLanguages.length === 0
          ? t('warnings.checks.languagesAll')
          : result.missingLanguages.every((value) => value === 'en')
            ? t('warnings.checks.languagesRequired')
            : t('warnings.checks.languagesMissing', {
                languages: result.missingLanguages.map(languageName).join(', '),
              })
      case 'areas':
        return draft.areas.length === 0
          ? t('warnings.checks.areasMissing')
          : t('warnings.checks.areas', {
              areas: t('warnings.checks.areasCount', { count: draft.areas.length }),
            })
      case 'headline':
        return result.longHeadlines.length === 0
          ? t('warnings.checks.headlineOk')
          : t('warnings.checks.headlineLong', {
              languages: result.longHeadlines.map(languageName).join(', '),
            })
      case 'expires':
        return result.expired
          ? t('warnings.checks.expired')
          : draft.expires
            ? t('warnings.checks.expiresOk')
            : t('warnings.checks.expiresMissing')
      case 'categories':
        return t('warnings.checks.categories')
      default:
        return t('warnings.checks.signer')
    }
  }

  // ── Предпросмотр для получателей ─────────────────────────────────────────
  const info = draft.info[language]

  const sign = () => {
    if (!action) return
    decide.mutate({ action: 'sign', ...(action.requireMfa ? { code } : {}) })
  }
  const canSign =
    Boolean(action) && !action?.qualified && (!action?.requireMfa || code.length === CODE_LENGTH)

  return (
    <aside
      aria-label={t('warnings.decision.title')}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-md',
        className,
      )}
    >
      <div className="flex flex-col gap-3 border-b border-line px-4.5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-md font-semibold text-fg">{t('warnings.decision.title')}</h2>
          {leftText ? (
            <span
              role="timer"
              aria-label={t('warnings.decision.leftLabel', { time: leftText })}
              className={cn(
                'tabular shrink-0 whitespace-nowrap font-mono text-xs font-semibold',
                left !== null && left < 0
                  ? 'text-danger'
                  : left !== null && left <= 15
                    ? 'text-warning'
                    : 'text-fg-secondary',
              )}
            >
              {leftText}
            </span>
          ) : null}
        </div>
        {processes.isLoading || (latest && view.isLoading) ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <ol className="flex flex-col">
            <DecisionStep
              state={isDraft ? 'current' : 'done'}
              title={preparedTitle}
              hint={preparedHint}
            />
            <DecisionStep
              state={decisionState}
              title={t('warnings.decision.step', { names })}
              hint={decisionHint}
              last
            />
          </ol>
        )}
      </div>

      <div className="flex flex-col gap-2 border-b border-line px-4.5 py-3.5">
        <h3 className="font-mono text-2xs uppercase tracking-widest text-fg-muted">
          {t(isDraft ? 'warnings.checks.titleSubmit' : 'warnings.checks.titleSign')}
        </h3>
        <ul className="flex flex-col gap-2">
          {result.checks.map((check) => (
            <li key={check.key} className="flex items-start gap-2 text-sm text-fg">
              {check.state === 'ok' ? (
                <Check
                  className="mt-0.5 size-4 shrink-0 text-success"
                  strokeWidth={2.4}
                  aria-hidden
                />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <span>
                {checkText(check.key)}
                <span className="sr-only">
                  {` · ${t(check.state === 'ok' ? 'warnings.checks.ok' : 'warnings.checks.missing')}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 border-b border-line bg-surface-2 px-4.5 py-3.5">
        <h3 className="font-mono text-2xs uppercase tracking-widest text-fg-muted">
          {t('warnings.preview.title', { language: languageName(language) })}
        </h3>
        <div
          lang={language}
          className="flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2.5"
        >
          {info?.headline ? (
            <>
              <span
                className={cn(
                  'flex items-center gap-1.5 text-2xs font-semibold',
                  LEVEL_TEXT[level],
                )}
              >
                <HazardMark level={level} size="sm" />
                {info.event || t(`warnings.severity.${draft.severity}`)}
              </span>
              <span className="text-sm font-semibold text-pretty text-fg">{info.headline}</span>
            </>
          ) : (
            <span className="text-sm text-fg-muted">{t('warnings.preview.empty')}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4.5 py-4">
        {isDraft ? (
          warning.canSubmit ? (
            <Button
              variant="primary"
              icon={<Send className="size-4" />}
              loading={submitting}
              onClick={onSubmit}
            >
              {t('warnings.card.submit')}
            </Button>
          ) : null
        ) : action ? (
          <>
            {action.onBehalfOf ? (
              <p className="text-xs text-fg-secondary">
                {t('warnings.decision.onBehalf', { name: action.onBehalfOf.displayName })}
              </p>
            ) : null}
            {action.qualified ? (
              <p className="text-xs text-fg-muted">{t('warnings.decision.qualified')}</p>
            ) : action.requireMfa ? (
              <Field label={t('warnings.decision.code')} htmlFor={codeId}>
                <CodeInput
                  id={codeId}
                  value={code}
                  onValueChange={setCode}
                  length={CODE_LENGTH}
                  disabled={decide.isPending}
                />
              </Field>
            ) : null}
            <Button
              variant="primary"
              icon={<ShieldCheck className="size-4" />}
              disabled={!canSign || decide.isPending}
              loading={decide.isPending && decide.variables?.action === 'sign'}
              onClick={sign}
            >
              {t('warnings.decision.sign')}
            </Button>
            {action.actions.includes('refuse') ? (
              <Button
                variant="secondary"
                icon={<Undo2 className="size-4" />}
                disabled={decide.isPending}
                onClick={() => setReturning(true)}
              >
                {t('warnings.decision.return')}
              </Button>
            ) : null}
            <p className="text-center text-xs text-fg-muted">{t('warnings.decision.after')}</p>
          </>
        ) : warning.publishedAt ? (
          <p className="text-sm text-fg-secondary">
            {t('warnings.decision.published', { date: dateOf(warning.publishedAt) })}
          </p>
        ) : step?.status === 'active' && !meAssigned ? (
          <p className="text-sm text-fg-secondary">{t('warnings.decision.waiting', { names })}</p>
        ) : null}
        {latest ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Route className="size-3.5" />}
            onClick={() => setRouteOpen(true)}
          >
            {t('warnings.decision.fullRoute')}
          </Button>
        ) : null}
      </div>

      <Dialog open={returning} onOpenChange={(open) => (open ? undefined : setReturning(false))}>
        <DialogContent
          title={t('warnings.decision.return')}
          description={t('warnings.decision.returnHint')}
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setReturning(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!comment.trim()}
                loading={decide.isPending && decide.variables?.action === 'refuse'}
                onClick={() => decide.mutate({ action: 'refuse', comment: comment.trim() })}
              >
                {t('warnings.decision.return')}
              </Button>
            </>
          }
        >
          <Field label={t('warnings.decision.returnComment')} htmlFor={commentId} required>
            <Textarea
              id={commentId}
              autoFocus
              rows={4}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </DialogContent>
      </Dialog>

      <Dialog open={routeOpen} onOpenChange={setRouteOpen}>
        <DialogContent title={t('warnings.decision.fullRoute')} size="lg">
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <ObjectRoutePanel objectId={warning.id} onChanged={refresh} />
          </Suspense>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
