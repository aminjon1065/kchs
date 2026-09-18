import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { label?: ReactNode }
>(function Checkbox({ className, label, id, ...props }, ref) {
  const control = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={id}
      className={cn(
        'peer size-4 shrink-0 rounded-xs border border-line-strong bg-surface',
        'transition-colors duration-[var(--duration-fast)]',
        'hover:border-accent',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-accent-fg">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )

  if (!label) return control
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-fg select-none">
      {control}
      <span>{label}</span>
    </label>
  )
})

export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { label?: ReactNode }
>(function Switch({ className, label, ...props }, ref) {
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'bg-surface-3 transition-colors duration-[var(--duration-fast)]',
        'data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-surface shadow-sm ring-0',
          'transition-transform duration-[var(--duration-fast)] ease-standard',
          'translate-x-0.5 data-[state=checked]:translate-x-[15px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
  if (!label) return control
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-fg select-none">
      {control}
      <span>{label}</span>
    </label>
  )
})

export const RadioGroup = RadioGroupPrimitive.Root

export const RadioItem = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> & { label?: ReactNode }
>(function RadioItem({ className, label, ...props }, ref) {
  const control = (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'size-4 shrink-0 rounded-full border border-line-strong bg-surface',
        'data-[state=checked]:border-accent hover:border-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex size-full items-center justify-center">
        <span className="size-2 rounded-full bg-accent" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
  if (!label) return control
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-fg select-none">
      {control}
      <span>{label}</span>
    </label>
  )
})

// ─── Select ──────────────────────────────────────────────────────────────────

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { invalid?: boolean }
>(function SelectTrigger({ className, children, invalid, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex h-[var(--control-h)] w-full items-center justify-between gap-2 rounded-sm border',
        'border-line-strong bg-surface px-2.5 text-sm text-fg',
        'transition-colors duration-[var(--duration-fast)]',
        'hover:border-accent focus:border-accent data-[placeholder]:text-fg-muted',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    >
      <span className="truncate text-left">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-fg-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={4}
        className={cn(
          'z-(--z-modal) max-h-72 min-w-[8rem] overflow-hidden rounded-md border border-line',
          'bg-overlay text-fg shadow-md',
          'data-[state=open]:animate-enter',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-xs py-1.5 pl-2 pr-7 text-sm',
        'outline-none data-[highlighted]:bg-surface-3 data-[state=checked]:font-medium',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
})

export const SelectSeparator = () => <div className="my-1 h-px bg-line" />

export const SelectLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-fg-muted">
    {children}
  </div>
)

// ─── SegmentedControl ────────────────────────────────────────────────────────

export interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode; title?: string }>
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = 'md',
  className,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onValueChange(next as T)}
      aria-label={props['aria-label']}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-sm border border-line bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          title={option.title}
          aria-label={typeof option.label === 'string' && option.label ? undefined : option.title}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-xs px-2 font-medium text-fg-secondary',
            'transition-colors duration-[var(--duration-fast)]',
            'hover:text-fg data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-sm',
            size === 'sm' ? 'h-6 text-xs' : 'h-7 text-sm',
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
