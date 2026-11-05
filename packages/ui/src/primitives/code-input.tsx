import { forwardRef, type InputHTMLAttributes, useRef, useState } from 'react'
import { cn } from '../lib/cn.js'

// Полные строки классов: Tailwind собирает только то, что видит в исходнике целиком
const COLUMNS = {
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
  7: 'grid-cols-7',
  8: 'grid-cols-8',
} as const
const COLUMN_START = [
  'col-start-1',
  'col-start-2',
  'col-start-3',
  'col-start-4',
  'col-start-5',
  'col-start-6',
  'col-start-7',
  'col-start-8',
] as const

export type CodeLength = keyof typeof COLUMNS

/** Только цифры и не длиннее кода: так же обрабатываются набор, вставка и автозаполнение. */
export function normalizeCode(value: string, length: CodeLength): string {
  return value.replace(/\D/g, '').slice(0, length)
}

export interface CodeInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'maxLength' | 'type' | 'size'
  > {
  value: string
  onValueChange: (value: string) => void
  /** Цифр в коде: у приложения-аутентификатора — шесть. */
  length?: CodeLength
  invalid?: boolean
  /** Код набран полностью — например, чтобы сразу перевести фокус на кнопку. */
  onComplete?: (value: string) => void
}

/**
 * Код подтверждения по ячейкам (подпись, вход с MFA). Поле одно и настоящее —
 * `one-time-code`: вставка, автозаполнение и чтение с экрана работают как у обычного
 * поля. Оно стоит поверх ячейки, куда пойдёт следующая цифра, поэтому кольцо фокуса
 * обводит именно её; остальные ячейки только показывают набранное.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  {
    value,
    onValueChange,
    length = 6,
    invalid,
    onComplete,
    disabled,
    className,
    onFocus,
    onBlur,
    ...props
  },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)
  const digits = normalizeCode(value, length)
  const active = Math.min(digits.length, length - 1)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: щелчок по ячейке ставит фокус в поле — им же пользуется клавиатура
    // biome-ignore lint/a11y/useKeyWithClickEvents: с клавиатуры фокус приходит в само поле
    <div
      className={cn('grid gap-1.5', COLUMNS[length], className)}
      onClick={() => inner.current?.focus()}
    >
      {Array.from({ length }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            'tabular row-start-1 flex h-11 items-center justify-center rounded-sm border font-mono text-lg font-semibold',
            COLUMN_START[index],
            disabled ? 'bg-surface-2 text-fg-muted' : 'bg-surface text-fg',
            invalid
              ? 'border-danger'
              : focused && index === active
                ? 'border-accent'
                : 'border-line-strong',
          )}
        >
          {digits[index] ?? ''}
        </span>
      ))}
      <input
        {...props}
        ref={(node) => {
          inner.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        value={digits}
        className={cn(
          'row-start-1 h-11 w-full rounded-sm bg-transparent text-transparent caret-transparent outline-none',
          COLUMN_START[active],
          disabled && 'cursor-not-allowed',
        )}
        onChange={(event) => {
          const next = normalizeCode(event.target.value, length)
          onValueChange(next)
          if (next.length === length && next !== digits) onComplete?.(next)
        }}
        onFocus={(event) => {
          setFocused(true)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
      />
    </div>
  )
})
