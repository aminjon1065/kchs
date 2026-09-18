import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Check, ChevronRight, X } from 'lucide-react'
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactNode } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { IconButton } from './button.js'

// ─── Tooltip ─────────────────────────────────────────────────────────────────

export const TooltipProvider = TooltipPrimitive.Provider

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delay?: number
  shortcut?: string
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay = 400,
  shortcut,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'z-(--z-tooltip) flex items-center gap-2 rounded-sm border border-line bg-overlay',
            'px-2 py-1 text-xs text-fg shadow-md',
            'data-[state=delayed-open]:animate-enter',
          )}
        >
          {content}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-line',
        'bg-surface-2 px-1 font-sans text-2xs font-medium text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

// ─── Popover ─────────────────────────────────────────────────────────────────

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-(--z-modal) rounded-md border border-line bg-overlay p-3 text-fg shadow-md',
          'origin-(--radix-popover-content-transform-origin) data-[state=open]:animate-enter',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})

// ─── DropdownMenu ────────────────────────────────────────────────────────────

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group
export const DropdownMenuSub = DropdownMenuPrimitive.Sub
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const menuContentClass = cn(
  'z-(--z-modal) min-w-[11rem] overflow-hidden rounded-md border border-line',
  'bg-overlay p-1 text-fg shadow-md',
  'data-[state=open]:animate-enter',
)

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, align = 'start', ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn(menuContentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})

const menuItemClass = cn(
  'relative flex cursor-pointer select-none items-center gap-2 rounded-xs px-2 py-1.5 text-sm outline-none',
  'data-[highlighted]:bg-surface-3',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
)

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    icon?: ReactNode
    shortcut?: string
    danger?: boolean
  }
>(function DropdownMenuItem({ className, icon, shortcut, danger, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        menuItemClass,
        danger && 'text-danger data-[highlighted]:bg-danger-subtle',
        className,
      )}
      {...props}
    >
      {icon ? <span className="shrink-0 text-fg-muted">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </DropdownMenuPrimitive.Item>
  )
})

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(menuItemClass, 'pl-7', className)}
      {...props}
    >
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-2">
        <Check className="size-3.5" />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
})

export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(menuItemClass, 'pl-7', className)}
      {...props}
    >
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-2">
        <span className="size-1.5 rounded-full bg-accent" />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
})

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { icon?: ReactNode }
>(function DropdownMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(menuItemClass, className)} {...props}>
      {icon ? <span className="shrink-0 text-fg-muted">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      <ChevronRight className="size-3.5 text-fg-muted" />
    </DropdownMenuPrimitive.SubTrigger>
  )
})

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        className={cn(menuContentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})

export const DropdownMenuSeparator = () => <div className="my-1 h-px bg-line" />

export const DropdownMenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-fg-muted">
    {children}
  </div>
)

// ─── Dialog ──────────────────────────────────────────────────────────────────

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export interface DialogContentProps
  extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode
  description?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  footer?: ReactNode
  hideClose?: boolean
}

const dialogSizes = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[760px]',
  xl: 'max-w-[1000px]',
}

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className, title, description, size = 'md', footer, hideClose, children, ...props },
  ref,
) {
  const t = useUiT()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-(--z-overlay) bg-black/35 backdrop-blur-[1px]',
          'data-[state=open]:animate-fade',
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-(--z-modal) flex w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100vh-4rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg',
          'data-[state=open]:animate-enter',
          dialogSizes[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="truncate text-md font-semibold text-fg">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-xs text-fg-secondary">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {!hideClose ? (
            <DialogPrimitive.Close asChild>
              <IconButton label={t('ui.actions.close')} size="md">
                <X className="size-4" />
              </IconButton>
            </DialogPrimitive.Close>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

// ─── Sheet (боковая панель) ─────────────────────────────────────────────────

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export interface SheetContentProps
  extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode
  description?: ReactNode
  side?: 'right' | 'left' | 'bottom'
  width?: string
  footer?: ReactNode
}

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  { className, title, description, side = 'right', width = '440px', footer, children, ...props },
  ref,
) {
  const t = useUiT()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-overlay) bg-black/25 data-[state=open]:animate-fade" />
      <DialogPrimitive.Content
        ref={ref}
        style={side === 'bottom' ? undefined : { width }}
        className={cn(
          'fixed z-(--z-modal) flex flex-col border-line bg-surface shadow-lg',
          side === 'right' &&
            'inset-y-0 right-0 max-w-full border-l data-[state=open]:animate-slide-right',
          side === 'left' &&
            'inset-y-0 left-0 max-w-full border-r data-[state=open]:animate-slide-right',
          side === 'bottom' &&
            'inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t data-[state=open]:animate-slide-up',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="truncate text-md font-semibold">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-xs text-fg-secondary">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton label={t('ui.actions.close')}>
              <X className="size-4" />
            </IconButton>
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

// ─── AlertDialog (разрушительные действия) ──────────────────────────────────

export interface AlertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Что именно будет затронуто — список зависимостей. */
  consequences?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void | Promise<void>
  destructive?: boolean
  loading?: boolean
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = true,
  loading,
}: AlertDialogProps) {
  const t = useUiT()
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-overlay) bg-black/35 data-[state=open]:animate-fade" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-(--z-modal) w-[calc(100vw-2rem)] max-w-[440px]',
            '-translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-4 shadow-lg',
            'data-[state=open]:animate-enter',
          )}
        >
          <DialogPrimitive.Title className="text-md font-semibold text-fg">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1.5 text-sm text-fg-secondary">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {consequences ? (
            <div className="mt-3 rounded-sm border border-line bg-surface-2 p-2.5 text-xs text-fg-secondary">
              {consequences}
            </div>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="inline-flex h-[var(--control-h)] items-center rounded-sm border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-surface-3"
              >
                {cancelLabel ?? t('ui.actions.cancel')}
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              disabled={loading}
              onClick={() => void onConfirm()}
              className={cn(
                'inline-flex h-[var(--control-h)] items-center rounded-sm px-3 text-sm font-medium text-white',
                'disabled:opacity-45',
                destructive ? 'bg-danger hover:opacity-90' : 'bg-accent hover:bg-accent-hover',
              )}
            >
              {confirmLabel ?? t('ui.actions.confirm')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
