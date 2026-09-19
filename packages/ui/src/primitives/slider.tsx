import * as SliderPrimitive from '@radix-ui/react-slider'
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react'
import { cn } from '../lib/cn.js'

export interface SliderProps
  extends Omit<ComponentPropsWithoutRef<typeof SliderPrimitive.Root>, 'aria-label'> {
  /**
   * Подписи бегунков для скринридера — по одной на значение (у диапазона —
   * «с» и «по»). Без них — общая подпись `aria-label` у каждого бегунка.
   */
  thumbLabels?: readonly string[]
  'aria-label'?: string
  /** Текст значения для скринридера (дата вместо номера шага). */
  valueText?: (value: number, index: number) => string
  size?: 'sm' | 'md'
}

/**
 * Ползунок (02-design-system.md, базовые): одно значение или диапазон — по
 * числу значений в `value`. Клавиатура — стрелки, Page Up/Down, Home/End;
 * бегунки не меняются местами (`minStepsBetweenThumbs` — зазор диапазона).
 */
export const Slider = forwardRef<ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  function Slider(
    {
      className,
      thumbLabels,
      valueText,
      size = 'md',
      'aria-label': ariaLabel,
      value,
      defaultValue,
      ...props
    },
    ref,
  ) {
    const count = (value ?? defaultValue ?? [0]).length
    const current = value ?? defaultValue ?? []
    return (
      <SliderPrimitive.Root
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        className={cn(
          'relative flex w-full touch-none items-center select-none',
          size === 'sm' ? 'h-4' : 'h-5',
          'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45',
          className,
        )}
        {...props}
      >
        <SliderPrimitive.Track
          className={cn(
            'relative grow overflow-hidden rounded-full bg-line-strong',
            size === 'sm' ? 'h-1' : 'h-1.5',
          )}
        >
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
        </SliderPrimitive.Track>
        {Array.from({ length: count }, (_, index) => {
          const thumbValue = current[index]
          return (
            <SliderPrimitive.Thumb
              // Бегунки не переставляются: позиция — ключ
              key={index}
              aria-label={thumbLabels?.[index] ?? ariaLabel}
              aria-valuetext={
                valueText && thumbValue !== undefined ? valueText(thumbValue, index) : undefined
              }
              className={cn(
                'block rounded-full border-2 border-accent bg-surface shadow-sm',
                'transition-[box-shadow,transform] duration-[var(--duration-fast)] ease-standard',
                'hover:scale-110 data-[disabled]:pointer-events-none',
                size === 'sm' ? 'size-3.5' : 'size-4',
              )}
            />
          )
        })}
      </SliderPrimitive.Root>
    )
  },
)
