import * as PopoverPrimitive from '@radix-ui/react-popover'
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn.js'

/**
 * Карточка по наведению с задержкой 400 мс
 * (03-ui/04-interaction-patterns.md §12). Построена на Popover, чтобы
 * содержимое оставалось доступным с клавиатуры.
 */
const HoverCardContext = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  schedule: (open: boolean) => void
} | null>(null)

export function HoverCard({ children, delay = 400 }: { children: ReactNode; delay?: number }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = (next: boolean): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), next ? delay : 120)
  }

  return (
    <HoverCardContext.Provider value={{ open, setOpen, schedule }}>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </PopoverPrimitive.Root>
    </HoverCardContext.Provider>
  )
}

export function HoverCardTrigger({
  children,
  asChild,
}: {
  children: ReactNode
  asChild?: boolean
}) {
  const context = useContext(HoverCardContext)
  return (
    <PopoverPrimitive.Trigger
      asChild={asChild}
      onMouseEnter={() => context?.schedule(true)}
      onMouseLeave={() => context?.schedule(false)}
      onFocus={() => context?.setOpen(true)}
      onBlur={() => context?.setOpen(false)}
    >
      {children}
    </PopoverPrimitive.Trigger>
  )
}

export function HoverCardContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  const context = useContext(HoverCardContext)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={6}
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={() => context?.schedule(true)}
        onMouseLeave={() => context?.schedule(false)}
        className={cn(
          'z-(--z-tooltip) rounded-md border border-line bg-overlay p-3 shadow-md',
          'data-[state=open]:animate-enter',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
