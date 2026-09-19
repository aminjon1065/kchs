import { IconButton } from '@kchs/ui'
import { Clock3 } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useStudioTime } from './time-state.js'

/**
 * Время на карте (P2-E02 S05, ADR-0074): кнопка тулбара включает шкалу времени
 * для слоёв со временем (`style.time`). Включение ставит интервал по режиму —
 * диапазон во все данные или первый шаг; выключение снимает `t` с тайлов.
 */
export function TimeTools() {
  const t = useT()
  const time = useStudioTime()
  if (time.layers.length === 0) return null
  const on = time.time !== null
  return (
    <div className="flex items-center rounded-md border border-line bg-surface p-0.5 shadow-sm">
      <IconButton
        label={on ? t('gis.time.hide') : t('gis.time.show')}
        size="sm"
        active={on}
        aria-pressed={on}
        disabled={!on && !time.scale}
        onClick={() => (on ? time.disable() : time.enable())}
      >
        <Clock3 className="size-4" aria-hidden />
      </IconButton>
    </div>
  )
}
