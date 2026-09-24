import { IconButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { meQuery, serviceAccountsQuery } from '~/shared/api/queries.js'
import { ServiceAccountDialog } from './service-accounts.js'

/** Пустое значение выбора: служебная запись ещё не выбрана. */
const NONE = '__none__'

/**
 * Выбор служебной учётной записи «Работает от имени» (ADR-0130) — у правила и формы
 * одинаковый: в списке только действующие служебные записи, выбранная и потом
 * заблокированная видна с пометкой; тот, кто ведёт пользователей, заводит новую
 * запись прямо отсюда.
 */
export function RunAsSelect({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id?: string
  value: string | null
  onChange: (next: string | null) => void
  disabled?: boolean
}) {
  const t = useT()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  const { data: accounts = [], refetch } = useQuery({
    ...serviceAccountsQuery(),
    enabled: !disabled,
  })
  const [creating, setCreating] = useState(false)
  const canCreate = me?.capabilities.includes('users.manage') ?? false
  const active = accounts.filter((account) => account.status === 'active')
  const current = accounts.find((account) => account.id === value)

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value ?? NONE}
        disabled={disabled}
        onValueChange={(next) => onChange(next === NONE ? null : next)}
        // Список перечитывается при открытии: запись, заведённая в другой вкладке или
        // другим администратором, видна без перезагрузки
        onOpenChange={(open) => {
          if (open) void refetch()
        }}
      >
        <SelectTrigger id={id} className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('automation.fields.runAsNone')}</SelectItem>
          {active.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name}
            </SelectItem>
          ))}
          {value && !active.some((item) => item.id === value) ? (
            <SelectItem value={value}>
              {current
                ? t('automation.fields.runAsBlocked', { name: current.name })
                : t('automation.fields.runAsUnknown')}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {canCreate && !disabled ? (
        <IconButton
          size="sm"
          variant="ghost"
          label={t('automation.fields.runAsCreate')}
          onClick={() => setCreating(true)}
        >
          <Bot className="size-4" />
        </IconButton>
      ) : null}
      <ServiceAccountDialog
        accountId={null}
        open={creating}
        onOpenChange={setCreating}
        onSaved={(account) => {
          onChange(account.id)
          void client.invalidateQueries({ queryKey: ['users'] })
        }}
      />
    </div>
  )
}
