import type { WarningSummary } from '@kchs/contracts'
import { useQuery } from '@tanstack/react-query'
import { meQuery } from '~/shared/api/queries.js'
import { warningsQuery } from './queries.js'
import { ACTIVE_WARNINGS_QUERY } from './situation.js'

/**
 * Опубликованные предупреждения, видимые сотруднику, — для полосы обстановки,
 * ситуационного экрана и зон на карте (ADR-0230): опрос раз в минуту, сброс realtime
 * по ключу `['warnings']`. `null` — экран предупреждений выключен или запрос не прошёл:
 * обстановку не показывают, а не показывают «норму».
 */
export function usePublishedWarnings(): readonly WarningSummary[] | null {
  const { data: me } = useQuery(meQuery())
  const hidden = new Set<string>(me?.hiddenScreens ?? []).has('warnings')
  const { data } = useQuery({
    ...warningsQuery(ACTIVE_WARNINGS_QUERY),
    enabled: Boolean(me) && !hidden,
    refetchInterval: 60_000,
    retry: false,
  })
  return hidden || !data ? null : data.items
}
