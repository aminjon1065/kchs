import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCog } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getOnBehalfOf, setOnBehalfOf } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'

/**
 * «Вы замещаете …» (03-access-model.md §Делегирование): действия заместителя
 * записываются с `onBehalfOf`, режим включается явно и виден всё время.
 */
export function ActingBanner() {
  const t = useT()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  // Режим живёт в клиенте API (заголовок запросов) и здесь — в состоянии: баннер
  // перерисовывается от выбора, а не от того, что кто-то выше перечитал `/me`
  const [chosen, setChosen] = useState<string | null>(getOnBehalfOf)
  const acting = me?.session.onBehalfOf ?? chosen
  const options = me?.actingFor ?? []

  const apply = (userId: string | null): void => {
    setOnBehalfOf(userId)
    setChosen(userId)
    void client.invalidateQueries()
  }

  // Замещение закончилось, пока вкладка была открыта — выходим из режима.
  // Пока `/me` не пришёл, список замещаемых неизвестен, а не пуст
  useEffect(() => {
    if (!me) return
    const current = getOnBehalfOf()
    if (current && !me.actingFor.some((item) => item.fromUser.id === current)) {
      setOnBehalfOf(null)
      setChosen(null)
      void client.invalidateQueries()
    }
  }, [me, client])

  if (options.length === 0) return null

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-warning/40 bg-warning-subtle px-3 text-xs text-fg">
      <UserCog className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="shrink-0 font-medium">{t('access.delegation.bannerTitle')}</span>

      <Select
        value={acting ?? 'none'}
        onValueChange={(next) => apply(next === 'none' ? null : next)}
      >
        <SelectTrigger
          aria-label={t('access.delegation.bannerTitle')}
          className="h-6 w-auto min-w-[200px] border-none bg-transparent px-1.5 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('access.delegation.actAsSelf')}</SelectItem>
          {options.map((item) => (
            <SelectItem key={item.id} value={item.fromUser.id}>
              {item.fromUser.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {acting ? (
        <Button size="sm" variant="ghost" onClick={() => apply(null)}>
          {t('access.delegation.exit')}
        </Button>
      ) : null}
    </div>
  )
}
