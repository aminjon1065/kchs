import { Eye, EyeOff, Search, X } from 'lucide-react'
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { IconButton } from './button.js'

const fieldBase = [
  'w-full rounded-sm border bg-surface text-fg',
  'border-line-strong placeholder:text-fg-muted',
  'transition-colors duration-[var(--duration-fast)]',
  'hover:border-line-strong focus:border-accent',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted',
  'read-only:bg-surface-2',
].join(' ')

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  invalid?: boolean
  /** Ведущий элемент внутри поля: иконка, префикс кода. */
  prefix?: ReactNode
  suffix?: ReactNode
  /** Моноширинный ввод: коды, координаты, идентификаторы. */
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, prefix, suffix, mono, ...props },
  ref,
) {
  if (!prefix && !suffix) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldBase,
          'h-[var(--control-h)] px-2.5 text-sm',
          mono && 'font-mono text-xs',
          invalid && 'border-danger focus:border-danger',
          className,
        )}
        {...props}
      />
    )
  }

  return (
    <div
      data-field
      className={cn(
        fieldBase,
        'flex h-[var(--control-h)] items-center gap-1.5 px-2.5 focus-within:border-accent',
        invalid && 'border-danger',
        className,
      )}
    >
      {prefix ? <span className="shrink-0 text-fg-muted">{prefix}</span> : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-muted',
          mono && 'font-mono text-xs',
        )}
        {...props}
      />
      {suffix ? <span className="shrink-0 text-fg-muted">{suffix}</span> : null}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  /** Авторост по содержимому. */
  autoGrow?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, autoGrow, onInput, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        'min-h-[72px] resize-y px-2.5 py-2 text-sm leading-base',
        invalid && 'border-danger focus:border-danger',
        className,
      )}
      onInput={(event) => {
        if (autoGrow) {
          const el = event.currentTarget
          el.style.height = 'auto'
          el.style.height = `${el.scrollHeight}px`
        }
        onInput?.(event)
      }}
      {...props}
    />
  )
})

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, ...props },
  ref,
) {
  const t = useUiT()
  const [visible, setVisible] = useState(false)
  return (
    <Input
      ref={ref}
      type={visible ? 'text' : 'password'}
      className={className}
      suffix={
        <IconButton
          type="button"
          size="sm"
          label={visible ? t('ui.password.hide') : t('ui.password.show')}
          onClick={() => setVisible((v) => !v)}
          tabIndex={-1}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </IconButton>
      }
      {...props}
    />
  )
})

export interface SearchInputProps extends Omit<InputProps, 'prefix' | 'suffix' | 'onChange'> {
  value: string
  onValueChange: (value: string) => void
  onClear?: () => void
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onValueChange, onClear, placeholder, ...props },
  ref,
) {
  const t = useUiT()
  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      value={value}
      placeholder={placeholder ?? t('ui.search.placeholder')}
      onChange={(event) => onValueChange(event.target.value)}
      prefix={<Search className="size-4" aria-hidden />}
      suffix={
        value ? (
          <IconButton
            type="button"
            size="sm"
            label={t('ui.search.clear')}
            onClick={() => {
              onValueChange('')
              onClear?.()
            }}
            tabIndex={-1}
          >
            <X className="size-3.5" />
          </IconButton>
        ) : undefined
      }
      {...props}
    />
  )
})

export interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  htmlFor?: string
  children: ReactNode
  className?: string
}

/** Обёртка поля формы: подпись, подсказка, ошибка под полем. */
export function Field({ label, hint, error, required, htmlFor, children, className }: FieldProps) {
  const generatedId = useId()
  const id = htmlFor ?? generatedId
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={id} className="text-xs font-medium text-fg-secondary">
          {label}
          {required ? <span className="ml-0.5 text-danger">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-muted">{hint}</p>
      ) : null}
    </div>
  )
}
