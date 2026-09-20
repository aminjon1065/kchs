import { Badge, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { FormControlTab } from './form-control-tab.js'
import { FormFillTab } from './form-fill-tab.js'
import { FormSettingsTab } from './form-settings-tab.js'
import { formQuery } from './queries.js'

/**
 * Карточка формы сбора данных (ADR-0103): заполнение для назначенного,
 * контроль сдачи для ведущего форму и её настройка.
 */
export function FormView({ objectId }: { objectId: string }) {
  const t = useT()
  const { data: form, isLoading, error, refetch } = useQuery(formQuery(objectId))
  const [tab, setTab] = useState<string>('fill')

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error || !form) return <ErrorState onRetry={() => void refetch()} />

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <h2 className="text-base font-semibold text-fg">{form.name}</h2>
        <Badge tone={form.enabled ? 'success' : 'neutral'} size="sm">
          {form.enabled ? t('forms.state.enabled') : t('forms.state.disabled')}
        </Badge>
        <Badge tone="neutral" size="sm">
          {t(`forms.periodicity.${form.definition.schedule.periodicity}`)}
        </Badge>
        {form.datasetName ? (
          <span className="text-xs text-fg-muted">{form.datasetName}</span>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="fill">{t('forms.tabs.fill')}</TabsTrigger>
          <TabsTrigger value="control">{t('forms.tabs.control')}</TabsTrigger>
          {form.canManage ? (
            <TabsTrigger value="settings">{t('forms.tabs.settings')}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="fill" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <FormFillTab form={form} />
        </TabsContent>
        <TabsContent value="control" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <FormControlTab form={form} />
        </TabsContent>
        {form.canManage ? (
          <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
            <FormSettingsTab form={form} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}
