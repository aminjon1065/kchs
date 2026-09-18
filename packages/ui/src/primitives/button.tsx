import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 shrink-0 select-none whitespace-nowrap',
    'rounded-sm border font-medium',
    'transition-colors duration-[var(--duration-fast)] ease-standard',
    'focus-visible:outline-none focus-visible:ring-0',
    'disabled:pointer-events-none disabled:opacity-45',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-fg border-transparent hover:bg-accent-hover active:bg-accent-hover shadow-sm',
        secondary: 'bg-surface text-fg border-line-strong hover:bg-surface-3 active:bg-surface-3',
        ghost:
          'bg-transparent text-fg-secondary border-transparent hover:bg-surface-3 hover:text-fg',
        danger:
          'bg-danger text-danger-fg border-transparent hover:opacity-90 active:opacity-85 shadow-sm',
        link: 'bg-transparent text-accent border-transparent underline-offset-4 hover:underline px-0',
        subtle: 'bg-accent-subtle text-accent border-transparent hover:brightness-95',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-[var(--control-h)] px-3 text-sm',
        lg: 'h-9 px-4 text-base',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    asChild,
    loading,
    icon,
    iconRight,
    children,
    disabled,
    ...props
  },
  ref,
) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      ref={ref}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin-fast" /> : icon}
      {children}
      {iconRight}
    </Component>
  )
})

export const iconButtonVariants = cva(
  [
    'inline-flex items-center justify-center shrink-0 rounded-sm border',
    'transition-colors duration-[var(--duration-fast)] ease-standard',
    'disabled:pointer-events-none disabled:opacity-45',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg border-transparent hover:bg-accent-hover',
        secondary: 'bg-surface text-fg border-line-strong hover:bg-surface-3',
        ghost:
          'bg-transparent text-fg-secondary border-transparent hover:bg-surface-3 hover:text-fg',
        danger: 'bg-transparent text-danger border-transparent hover:bg-danger-subtle',
      },
      size: { sm: 'size-6', md: 'size-7', lg: 'size-8' },
      active: { true: 'bg-accent-subtle text-accent', false: '' },
    },
    defaultVariants: { variant: 'ghost', size: 'md', active: false },
  },
)

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  /** Обязательно: кнопка без текста должна быть озвучена скринридером. */
  label: string
  asChild?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, active, label, asChild, children, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(iconButtonVariants({ variant, size, active }), className)}
      {...props}
    >
      {children}
    </Component>
  )
})
