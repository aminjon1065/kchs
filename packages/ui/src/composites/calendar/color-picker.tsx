import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '../../lib/cn.js'
import { type CalendarTone, toneClasses } from './tones.js'

const DEFAULT = '__default'

export interface CalendarColorPickerProps {
  value: CalendarTone | null
  onChange: (next: CalendarTone | null) => void
  colors: readonly CalendarTone[]
  /** Названия цветов для скринридера и подсказки. */
  labels: Record<CalendarTone, string>
  /** Подпись варианта «как у календаря»; не задана — вариант не показывается. */
  defaultLabel?: string | null
  'aria-label': string
  className?: string
}

/**
 * Выбор цвета календаря или события: кружки палитры (`chart-1…10`) и,
 * если нужно, «как у календаря». Радиогруппа — стрелки переключают цвет.
 */
export function CalendarColorPicker({
  value,
  onChange,
  colors,
  labels,
  defaultLabel = null,
  className,
  ...props
}: CalendarColorPickerProps) {
  return (
    <RadioGroupPrimitive.Root
      value={value ?? DEFAULT}
      onValueChange={(next) => onChange(next === DEFAULT ? null : (next as CalendarTone))}
      aria-label={props['aria-label']}
      orientation="horizontal"
      loop
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {defaultLabel ? (
        <RadioGroupPrimitive.Item
          value={DEFAULT}
          className={cn(
            'h-6 rounded-full border border-line-strong px-2 text-xs text-fg-secondary',
            'data-[state=checked]:border-accent data-[state=checked]:text-fg data-[state=checked]:ring-2 data-[state=checked]:ring-accent',
          )}
        >
          {defaultLabel}
        </RadioGroupPrimitive.Item>
      ) : null}
      {colors.map((color) => (
        <RadioGroupPrimitive.Item
          key={color}
          value={color}
          aria-label={labels[color]}
          title={labels[color]}
          className={cn(
            'size-6 rounded-full border border-line',
            toneClasses(color).dot,
            'data-[state=checked]:ring-2 data-[state=checked]:ring-accent data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-surface',
          )}
        />
      ))}
    </RadioGroupPrimitive.Root>
  )
}
