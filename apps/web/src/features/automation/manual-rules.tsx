import type { ManualRule } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import { AlertDialog, Button, useToast } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Zap } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, manualRulesQuery } from './queries.js'

/**
 * Ручной запуск правил у объекта (contracts/automation-rule.md §Триггеры):
 * кнопки в контекст-панели карточки. Список приходит с сервера — в нём только
 * включённые правила своего типа объекта, видимые смотрящему; правило
 * выполняется от имени своего служебного пользователя.
 */
export function ManualRuleActions({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const [confirming, setConfirming] = useState<ManualRule | null>(null)
  const { data: rules = [] } = useQuery(manualRulesQuery(objectId))

  const start = useMutation({
    mutationFn: (rule: ManualRule) => automationApi.run(rule.id, objectId),
    onSuccess: () => toast.show({ title: t('automation.manual.started'), tone: 'success' }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (rules.length === 0) return null

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
        <Zap className="size-3" aria-hidden />
        {t('automation.manual.menu')}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {rules.map((rule) => (
          <Button
            key={rule.id}
            size="sm"
            variant="secondary"
            loading={start.isPending && start.variables?.id === rule.id}
            onClick={() => (rule.confirm ? setConfirming(rule) : start.mutate(rule))}
          >
            {t('automation.manual.run', { name: localizedText(rule.name, locale) })}
          </Button>
        ))}
      </div>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
        title={t('automation.manual.confirmTitle')}
        description={
          confirming
            ? t('automation.manual.confirmText', { name: localizedText(confirming.name, locale) })
            : ''
        }
        confirmLabel={t('automation.manual.confirm')}
        loading={start.isPending}
        onConfirm={() => {
          if (confirming) start.mutate(confirming)
          setConfirming(null)
        }}
      />
    </div>
  )
}
