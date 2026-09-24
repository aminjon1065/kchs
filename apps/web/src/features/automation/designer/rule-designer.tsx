import type { RuleCondition, RuleDefinition, RuleIssue } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  IconButton,
  Input,
  PanelToolbar,
  SectionHeader,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { RunAsSelect } from '~/features/admin/run-as-select.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, automationKeys, ruleCatalogQuery, ruleQuery } from '../queries.js'
import { ActionEditor } from './action-editor.js'
import { DryRunPanel, RunsPanel } from './runs-panel.js'
import { TriggerEditor } from './trigger-editor.js'

/** Условия правила в конструкторе — плоский список выражений, объединённых «и». */
function conditionList(condition: RuleCondition | null): string[] {
  if (!condition) return []
  if ('expr' in condition) return [condition.expr]
  if ('and' in condition) return condition.and.flatMap(conditionList)
  if ('or' in condition) return condition.or.flatMap(conditionList)
  return conditionList(condition.not)
}

function conditionOf(expressions: string[]): RuleCondition | null {
  const list = expressions.map((item) => item.trim()).filter(Boolean)
  if (list.length === 0) return null
  if (list.length === 1) return { expr: list[0] as string }
  return { and: list.map((expr) => ({ expr })) }
}

/**
 * Конструктор правила «когда / если / то» (14-automation-integrations.md §1,
 * ADR-0096): форма с подсказками каталога событий, проверка на лету, тестовый
 * прогон и история запусков. Правило сохраняется целиком — черновиков нет,
 * состояние переключается флажком «включено».
 */
export default function RuleDesigner({ ruleId }: { ruleId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const runAsId = useId()

  const { data: rule, isLoading } = useQuery(ruleQuery(ruleId))
  const { data: catalog } = useQuery(ruleCatalogQuery())
  const [draft, setDraft] = useState<RuleDefinition | null>(null)
  const [issues, setIssues] = useState<RuleIssue[]>([])
  const [jsonText, setJsonText] = useState('')

  useEffect(() => {
    if (rule && !draft) {
      setDraft(rule.definition)
      setJsonText(JSON.stringify(rule.definition, null, 2))
    }
  }, [rule, draft])

  const conditions = useMemo(() => conditionList(draft?.conditions ?? null), [draft])

  const validate = useMutation({
    mutationFn: (definition: RuleDefinition) => automationApi.validate(definition),
    onSuccess: (result) => setIssues(result.issues),
  })

  const save = useMutation({
    mutationFn: (definition: RuleDefinition) => automationApi.update(ruleId, definition),
    onSuccess: async () => {
      toast.show({ title: t('automation.designer.saved'), tone: 'success' })
      await client.invalidateQueries({ queryKey: automationKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const update = (next: RuleDefinition) => {
    setDraft(next)
    setJsonText(JSON.stringify(next, null, 2))
    validate.mutate(next)
  }

  if (isLoading || !rule || !draft) return <Skeleton className="m-6 h-64" />

  const errors = issues.filter((issue) => issue.severity === 'error')
  // Выбрать можно только действующую запись; заблокированная остаётся видна по имени

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-fg">
              {localizedText(draft.name, locale)}
            </h1>
            <Badge tone={draft.enabled ? 'success' : 'neutral'}>
              {draft.enabled ? t('automation.state.enabled') : t('automation.state.disabled')}
            </Badge>
          </div>
        }
        right={
          <div className="flex items-center gap-2">
            <Switch
              checked={draft.enabled}
              aria-label={t('automation.fields.enabled')}
              disabled={!rule.canManage}
              onCheckedChange={(checked) => update({ ...draft, enabled: checked })}
            />
            <Button
              variant="primary"
              disabled={!rule.canManage || errors.length > 0}
              loading={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              <Save className="size-4" />
              {t('automation.designer.save')}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <Card className="flex flex-col gap-3 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('automation.name')} htmlFor={nameId}>
                <Input
                  id={nameId}
                  value={draft.name.ru}
                  disabled={!rule.canManage}
                  onChange={(event) =>
                    update({ ...draft, name: { ...draft.name, ru: event.target.value } })
                  }
                />
              </Field>
              <Field
                label={t('automation.fields.runAs')}
                htmlFor={runAsId}
                hint={t('automation.fields.runAsHint')}
              >
                <RunAsSelect
                  id={runAsId}
                  value={draft.runAs}
                  disabled={!rule.canManage}
                  onChange={(next) => update({ ...draft, runAs: next })}
                />
              </Field>
              <div className="md:col-span-2">
                <Field label={t('automation.fields.description')}>
                  <Textarea
                    value={draft.description ?? ''}
                    disabled={!rule.canManage}
                    aria-label={t('automation.fields.description')}
                    onChange={(event) =>
                      update({ ...draft, description: event.target.value || null })
                    }
                  />
                </Field>
              </div>
            </div>
          </Card>

          <section className="flex flex-col gap-3">
            <SectionHeader title={t('automation.designer.when')} />
            <Card className="p-4">
              <TriggerEditor
                trigger={draft.trigger}
                catalog={catalog}
                webhookUrl={rule.webhookUrl}
                disabled={!rule.canManage}
                onChange={(trigger) => update({ ...draft, trigger })}
              />
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader
              title={t('automation.designer.if')}
              description={t('automation.designer.conditionsHint')}
            />
            <Card className="flex flex-col gap-2 p-4">
              {conditions.map((expression, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={expression}
                    disabled={!rule.canManage}
                    placeholder={t('automation.designer.conditionPlaceholder')}
                    aria-label={t('automation.designer.if')}
                    onChange={(event) => {
                      const next = conditions.map((item, position) =>
                        position === index ? event.target.value : item,
                      )
                      update({ ...draft, conditions: conditionOf(next) })
                    }}
                  />
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('automation.designer.conditionRemove')}
                    disabled={!rule.canManage}
                    onClick={() =>
                      update({
                        ...draft,
                        conditions: conditionOf(
                          conditions.filter((_, position) => position !== index),
                        ),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!rule.canManage}
                  onClick={() =>
                    update({ ...draft, conditions: conditionOf([...conditions, 'true']) })
                  }
                >
                  <Plus className="size-4" />
                  {t('automation.designer.conditionAdd')}
                </Button>
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title={t('automation.designer.thenDo')} />
            <ActionEditor
              actions={draft.actions}
              disabled={!rule.canManage}
              onChange={(actions) => update({ ...draft, actions })}
            />
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title={t('automation.designer.limits')} />
            <Card className="grid gap-3 p-4 md:grid-cols-3">
              <Field label={t('automation.designer.maxRunsPerHour')}>
                <Input
                  type="number"
                  value={String(draft.limits.maxRunsPerHour)}
                  disabled={!rule.canManage}
                  aria-label={t('automation.designer.maxRunsPerHour')}
                  onChange={(event) =>
                    update({
                      ...draft,
                      limits: {
                        ...draft.limits,
                        maxRunsPerHour: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
              </Field>
              <Field label={t('automation.designer.dedupeKey')}>
                <Input
                  value={draft.limits.dedupeKey ?? ''}
                  disabled={!rule.canManage}
                  aria-label={t('automation.designer.dedupeKey')}
                  onChange={(event) =>
                    update({
                      ...draft,
                      limits: { ...draft.limits, dedupeKey: event.target.value || null },
                    })
                  }
                />
              </Field>
              <Field label={t('automation.designer.dedupeWindow')}>
                <Input
                  type="number"
                  value={String(draft.limits.dedupeWindowMinutes)}
                  disabled={!rule.canManage}
                  aria-label={t('automation.designer.dedupeWindow')}
                  onChange={(event) =>
                    update({
                      ...draft,
                      limits: {
                        ...draft.limits,
                        dedupeWindowMinutes: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
              </Field>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title={t('automation.designer.issues')} />
            {issues.length === 0 ? (
              <Callout tone="success">{t('automation.designer.noIssues')}</Callout>
            ) : (
              <div className="flex flex-col gap-2">
                {issues.map((issue) => (
                  <Callout
                    key={`${issue.path}-${issue.message}`}
                    tone={issue.severity === 'error' ? 'danger' : 'warning'}
                  >
                    <code className="font-mono text-xs">{issue.path}</code> — {issue.message}
                  </Callout>
                ))}
              </div>
            )}
          </section>

          <Tabs defaultValue="runs">
            <TabsList aria-label={t('automation.runs.title')}>
              <TabsTrigger value="runs">{t('automation.runs.title')}</TabsTrigger>
              <TabsTrigger value="dry-run">{t('automation.dryRun.title')}</TabsTrigger>
              <TabsTrigger value="json">{t('automation.designer.json')}</TabsTrigger>
            </TabsList>
            <TabsContent value="runs" className="pt-3">
              <RunsPanel ruleId={ruleId} />
            </TabsContent>
            <TabsContent value="dry-run" className="pt-3">
              <DryRunPanel definition={draft} />
            </TabsContent>
            <TabsContent value="json" className="flex flex-col gap-2 pt-3">
              <Textarea
                value={jsonText}
                rows={16}
                className="font-mono text-xs"
                aria-label={t('automation.designer.json')}
                onChange={(event) => setJsonText(event.target.value)}
              />
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!rule.canManage}
                  onClick={() => {
                    try {
                      update(JSON.parse(jsonText) as RuleDefinition)
                    } catch {
                      toast.error(t('automation.designer.jsonInvalid'))
                    }
                  }}
                >
                  {t('automation.designer.jsonApply')}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
