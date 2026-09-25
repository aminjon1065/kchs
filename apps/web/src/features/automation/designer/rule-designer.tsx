import type { RuleDefinition, RuleIssue } from '@kchs/contracts'
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
import { Copy, Download, Plus, Save } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { RunAsSelect } from '~/features/admin/run-as-select.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, automationKeys, ruleCatalogQuery, ruleQuery } from '../queries.js'
import { ActionEditor } from './action-editor.js'
import { defaultAction } from './action-fields.js'
import { ConditionTreeEditor } from './condition-tree.js'
import { DryRunPanel, RunsPanel } from './runs-panel.js'
import { TriggerEditor } from './trigger-editor.js'
import { VersionsPanel } from './versions-panel.js'

/** Файл правила (ADR-0163) — скачивание без отдельного маршрута: JSON уже на клиенте. */
function downloadJson(fileName: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
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
  const openTab = useWorkspace((state) => state.openTab)
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

  const duplicate = useMutation({
    mutationFn: () => automationApi.duplicate(ruleId),
    onSuccess: async ({ id }) => {
      toast.show({ title: t('automation.designer.duplicated'), tone: 'success' })
      await client.invalidateQueries({ queryKey: automationKeys.all })
      openTab({
        kind: 'screen',
        screen: 'rule-designer',
        params: { id },
        title: `${localizedText(draft?.name ?? { ru: '' }, locale)} (${t('automation.designer.copy')})`,
        icon: 'zap',
        mode: 'permanent',
      })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const exportRule = useMutation({
    mutationFn: () => automationApi.exportRule(ruleId),
    onSuccess: (file) => downloadJson(`${file.key}.rule.json`, file),
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
            <IconButton
              size="sm"
              variant="ghost"
              label={t('automation.designer.duplicate')}
              disabled={duplicate.isPending}
              onClick={() => duplicate.mutate()}
            >
              <Copy className="size-4" />
            </IconButton>
            <IconButton
              size="sm"
              variant="ghost"
              label={t('automation.designer.export')}
              disabled={exportRule.isPending}
              onClick={() => exportRule.mutate()}
            >
              <Download className="size-4" />
            </IconButton>
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
            <Card className="p-4">
              <ConditionTreeEditor
                condition={draft.conditions}
                disabled={!rule.canManage}
                onChange={(conditions) => update({ ...draft, conditions })}
              />
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
            <SectionHeader
              title={t('automation.designer.otherwise')}
              description={t('automation.designer.otherwiseHint')}
            />
            {draft.otherwise.length > 0 ? (
              <ActionEditor
                actions={draft.otherwise}
                disabled={!rule.canManage}
                onChange={(otherwise) => update({ ...draft, otherwise })}
              />
            ) : (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!rule.canManage || !draft.conditions}
                  onClick={() => update({ ...draft, otherwise: [defaultAction('notify')] })}
                >
                  <Plus className="size-4" />
                  {t('automation.designer.otherwiseAdd')}
                </Button>
              </div>
            )}
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
              <TabsTrigger value="versions">{t('automation.versions.title')}</TabsTrigger>
              <TabsTrigger value="json">{t('automation.designer.json')}</TabsTrigger>
            </TabsList>
            <TabsContent value="runs" className="pt-3">
              <RunsPanel ruleId={ruleId} />
            </TabsContent>
            <TabsContent value="dry-run" className="pt-3">
              <DryRunPanel definition={draft} />
            </TabsContent>
            <TabsContent value="versions" className="pt-3">
              <VersionsPanel
                ruleId={ruleId}
                canManage={rule.canManage}
                onRestored={(definition) => {
                  setDraft(definition)
                  setJsonText(JSON.stringify(definition, null, 2))
                  setIssues([])
                }}
              />
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
