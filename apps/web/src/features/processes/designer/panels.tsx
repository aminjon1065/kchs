import { formatDateTime } from '@kchs/fields'
import type { DefinitionIssue, ProcessDefinitionDetails } from '@kchs/process'
import { Badge, Button, Callout, Dialog, DialogContent, Field, Spinner, Textarea } from '@kchs/ui'
import { AlertTriangle, CircleX } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { type Definition, issueTarget } from '../model.js'
import { type Selection, useDesigner, useStepTitle } from './context.js'

/** Показать шаг на схеме: выбранная карточка прокручивается в видимую область. */
export function revealStep(key: string): void {
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-step-key="${CSS.escape(key)}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

/**
 * Проверка маршрута (ADR-0079): ошибки и предупреждения сервера с переходом
 * к шагу или разделу настроек маршрута.
 */
export function IssuesPanel({ checking }: { checking: boolean }) {
  const t = useT()
  const titleOf = useStepTitle()
  const { definition, issues, select } = useDesigner()
  const errors = issues.filter((issue) => issue.severity === 'error')
  const go = (issue: DefinitionIssue) => {
    const target = issueTarget(issue)
    const selection: Selection =
      target.kind === 'step' && definition.steps[target.key]
        ? { kind: 'step', key: target.key }
        : { kind: 'route', section: target.kind === 'route' ? target.section : 'general' }
    select(selection)
    if (selection.kind === 'step') revealStep(selection.key)
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      {checking ? (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner className="size-3.5" label={t('processDesigner.issues.checking')} />
          {t('processDesigner.issues.checking')}
        </p>
      ) : null}
      {issues.length === 0 ? (
        <Callout tone="success" title={t('processDesigner.issues.ok')} />
      ) : errors.length === 0 ? (
        <Callout tone="warning" title={t('processDesigner.issues.okWithWarnings')} />
      ) : null}
      <ul aria-label={t('processDesigner.panels.issues')} className="flex flex-col gap-2">
        {issues.map((issue) => {
          const target = issueTarget(issue)
          const where =
            target.kind === 'step'
              ? titleOf(target.key, definition.steps[target.key])
              : t(`processDesigner.issues.sections.${target.section}`)
          return (
            <li
              key={`${issue.path}:${issue.code}:${issue.message}`}
              className="flex items-start gap-2 rounded-md border border-line bg-surface p-2.5"
            >
              {issue.severity === 'error' ? (
                <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{issue.message}</p>
                <p className="text-xs text-fg-muted">
                  <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'} size="sm">
                    {t(`processDesigner.issues.${issue.severity}`)}
                  </Badge>{' '}
                  {where} · <code className="font-mono">{issue.path}</code>
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => go(issue)}>
                {t('processDesigner.issues.goTo')}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Определение маршрута текстом (docs/contracts/process-definition.md): правка
 * JSON применяется к схеме, как только текст разбирается и похож на маршрут.
 */
export function JsonView({ onApply }: { onApply: (definition: Definition) => void }) {
  const t = useT()
  const id = useId()
  const { definition, readOnly } = useDesigner()
  const serialized = JSON.stringify(definition, null, 2)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string | null>(null)
  // Схема изменилась снаружи (или применён этот текст) — показать актуальное определение
  useEffect(() => {
    setText(serialized)
    setError(null)
  }, [serialized])
  const parse = (value: string): Definition | null => {
    try {
      const shaped = asDefinition(JSON.parse(value) as unknown, definition)
      setError(shaped ? null : t('processDesigner.json.shape'))
      return shaped
    } catch (problem) {
      setError(
        t('processDesigner.json.invalid', {
          message: problem instanceof Error ? problem.message : String(problem),
        }),
      )
      return null
    }
  }
  const apply = () => {
    if (text === serialized) return
    const shaped = parse(text)
    if (shaped) onApply(shaped)
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-4">
      <Field
        label={t('processDesigner.json.label')}
        hint={t('processDesigner.json.hint')}
        error={error ?? undefined}
        htmlFor={id}
        className="min-h-0 flex-1"
      >
        <Textarea
          id={id}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          className="min-h-96 flex-1 font-mono text-xs"
          onChange={(event) => {
            setText(event.target.value)
            parse(event.target.value)
          }}
          onBlur={apply}
        />
      </Field>
      {readOnly ? null : (
        <div>
          <Button size="sm" disabled={text === serialized || Boolean(error)} onClick={apply}>
            {t('processDesigner.json.apply')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Похоже ли значение на маршрут настолько, чтобы схема его показала: шаги с
 * известным типом, начало — строка. Ключ и тип объекта не меняются; прочее
 * проверит сервер.
 */
export function asDefinition(value: unknown, current: Definition): Definition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const steps = raw.steps
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return null
  for (const step of Object.values(steps as Record<string, unknown>)) {
    if (
      !step ||
      typeof step !== 'object' ||
      typeof (step as { type?: unknown }).type !== 'string'
    ) {
      return null
    }
  }
  if (typeof raw.start !== 'string') return null
  return {
    ...(raw as unknown as Definition),
    key: current.key,
    objectType: current.objectType,
    version: 1,
    variables: (raw.variables as Definition['variables'] | undefined) ?? {},
    timers: Array.isArray(raw.timers) ? (raw.timers as Definition['timers']) : [],
    conditions: Array.isArray(raw.conditions) ? (raw.conditions as Definition['conditions']) : [],
  }
}

/** История версий: опубликованные и черновик, число идущих маршрутов; версию можно взять за основу. */
export function VersionsDialog({
  open,
  onOpenChange,
  details,
  onLoad,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  details: ProcessDefinitionDetails
  onLoad: (version: number) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { readOnly } = useDesigner()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('processDesigner.versions.title')} size="md">
        <ul className="flex flex-col divide-y divide-line">
          {details.versions.map((version) => (
            <li key={version.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {t('processDesigner.versions.version', { version: version.version })}
                </p>
                <p className="text-xs text-fg-muted">
                  {version.publishedAt
                    ? t('processDesigner.versions.published', {
                        date: formatDateTime(version.publishedAt, { locale }),
                      })
                    : t('processDesigner.versions.draft')}
                  {version.running > 0
                    ? ` · ${t('processDesigner.versions.running', { count: version.running })}`
                    : ''}
                </p>
              </div>
              {readOnly ? null : (
                <Button variant="ghost" size="sm" onClick={() => onLoad(version.version)}>
                  {t('processDesigner.versions.load')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
