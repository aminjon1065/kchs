import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCog } from 'lucide-react'
import { useEffect } from 'react'
import { useT } from '~/app/i18n.js'
import { getOnBehalfOf, setOnBehalfOf } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'

/**
 * «Вы замещаете …» (03-access-model.md §Делегирование): действия заместителя
 * записываются с `onBehalfOf`, режим включается явно и виден всё время.
 */
export function ActingBanner() {
  const t = useT()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  const acting = me?.session.onBehalfOf ?? getOnBehalfOf()
  const options = me?.actingFor ?? []

  // Замещение закончилось, пока вкладка была открыта — выходим из режима
  useEffect(() => {
    const current = getOnBehalfOf()
    if (current && !options.some((item) => item.fromUser.id === current)) {
      setOnBehalfOf(null)
      void client.invalidateQueries()
    }
  }, [options, client])

  if (options.length === 0) return null

  const apply = (userId: string | null): void => {
    setOnBehalfOf(userId)
    void client.invalidateQueries()
  }

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
