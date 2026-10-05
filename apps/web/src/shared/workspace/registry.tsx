import type { Namespace } from '@kchs/i18n'
import type { LucideIcon } from 'lucide-react'
import { type ReactNode, Suspense } from 'react'
import { useNamespacesReady, withNamespaces } from '~/shared/i18n.js'
import type { ScreenKey, TabState } from '~/shared/workspace/types.js'

/**
 * Реестр экранов оболочки: модуль регистрирует свои экраны и типы объектов
 * (01-project-structure.md §apps/web).
 */
export interface ScreenDefinition {
  key: ScreenKey
  /** Ключ словаря с названием экрана (`shell.rail.home`), не сам текст. */
  titleKey: string
  icon: string
  render: (tab: TabState) => ReactNode
  /** Что показывать в навигаторе при активном модуле. */
  navigator?: () => ReactNode
}

export interface ObjectViewDefinition {
  type: string
  render: (tab: TabState) => ReactNode
  /**
   * Секция вкладки «Сведения» контекст-панели для объекта этого типа — например,
   * действия шага документа (03-screens.md §12). Рисуется над общими сведениями.
   */
  contextSection?: (objectId: string) => ReactNode
  /**
   * Вкладка «Ассистент» контекст-панели (13-search-knowledge-ai.md §5): действия
   * ИИ над объектом — для документа краткое содержание и черновик ответа
   * (ADR-0088). Без неё вкладка недоступна.
   */
  assistantSection?: (objectId: string) => ReactNode
}

const screens = new Map<ScreenKey, ScreenDefinition>()
const objectViews = new Map<string, ObjectViewDefinition>()

export function getScreen(key: ScreenKey): ScreenDefinition | undefined {
  return screens.get(key)
}

export function getObjectView(type: string): ObjectViewDefinition | undefined {
  return objectViews.get(type)
}

// ─── Модули оболочки (ADR-0183) ──────────────────────────────────────────────

/** Значок пункта навигации — компонент иконки lucide-react. */
export type NavIcon = LucideIcon

/** Пункт навигации модуля: рейка и нижняя панель телефона. */
export interface NavItemDefinition {
  key: ScreenKey
  icon: NavIcon
  /** Ключ словаря подписи (`shell.rail.chats`). */
  labelKey: string
  /** Имя значка вкладки, которую открывает пункт. */
  tabIcon: string
  shortcut?: string
  /** Порядок в рейке: меньше — выше. */
  order: number
  /**
   * Число на значке (непрочитанное) — хук модуля. Реестр заполняется до первой
   * отрисовки и дальше не меняется, поэтому порядок вызова хуков стабилен.
   */
  useBadge?: () => number | undefined
}

/** Быстрое действие палитры по введённому тексту («встреча завтра в 10…»). */
export interface PaletteQuickAction {
  /** Ключ словаря заголовка группы. */
  groupKey: string
  icon: ReactNode
  label: string
  hint?: string
  run: () => void
}

/** Команда палитры от модуля. */
export interface PaletteCommand {
  id: string
  label: string
  icon: ReactNode
  run: () => void
  hidden?: boolean
}

/**
 * Возможности модулей, которые зовёт оболочка. Оболочка знает только этот реестр,
 * а не модули: нет модуля — нет и возможности, оболочка берёт запасной вариант.
 */
export interface ShellExtensions {
  /** Справка по текущему экрану; `null` — справки нет (модуль «Знания»). */
  useOpenHelp: () => (() => void) | null
  /** Есть ли у пользователя раздел консоли администрирования. */
  canOpenAdmin: (capabilities: readonly string[] | undefined) => boolean
  /** Быстрое действие палитры по тексту запроса. */
  usePaletteQuickAction: (query: string) => PaletteQuickAction | null
  /** Команды палитры модуля. */
  usePaletteCommands: () => PaletteCommand[]
}

/** Слой оболочки: баннер над рабочей областью, оверлей поверх неё или диалог по ключу. */
export type ShellSlotDefinition =
  | { key: string; placement: 'banner' | 'overlay'; render: () => ReactNode }
  | { key: string; placement: 'dialog'; render: (props: ShellDialogProps) => ReactNode }
  /**
   * Контекст-панель для любого объекта: секция вкладки «Сведения» (правила с ручным
   * запуском) или вкладка «Ассистент» (диалог с инструментами).
   */
  | {
      key: string
      placement: 'context-info' | 'context-assistant'
      render: (objectId: string) => ReactNode
    }

export interface ShellDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Всё, что модуль даёт оболочке, — одним вызовом `registerModule`. */
export interface ModuleDefinition {
  key: string
  /**
   * Неймспейсы словаря, которые нужны экранам, представлениям, слоям и командам палитры
   * модуля сверх неймспейсов оболочки (ADR-0191). Реестр показывает их, когда неймспейсы
   * загружены на языке интерфейса, — без сырых ключей; загрузка идёт параллельно с чанком
   * экрана. Подписи, которые рисует оболочка (`titleKey`, `labelKey`), — из неймспейсов
   * оболочки: словарь модуля к их показу может быть ещё не загружен. Полноту объявлений
   * проверяет `app/namespaces.test.ts`.
   */
  namespaces?: readonly Namespace[]
  screens?: ScreenDefinition[]
  objectViews?: ObjectViewDefinition[]
  nav?: NavItemDefinition[]
  extensions?: Partial<ShellExtensions>
  slots?: ShellSlotDefinition[]
}

const navItems = new Map<ScreenKey, NavItemDefinition>()
const extensions: Partial<ShellExtensions> = {}
const slots = new Map<string, ShellSlotDefinition>()

export function registerModule(definition: ModuleDefinition): void {
  const namespaces = definition.namespaces ?? []
  for (const screen of definition.screens ?? []) {
    screens.set(screen.key, gateScreen(screen, namespaces))
  }
  for (const view of definition.objectViews ?? []) {
    objectViews.set(view.type, gateObjectView(view, namespaces))
  }
  for (const item of definition.nav ?? []) navItems.set(item.key, item)
  Object.assign(extensions, gateExtensions(definition.extensions ?? {}, namespaces))
  for (const slot of definition.slots ?? []) slots.set(slot.key, gateSlot(slot, namespaces))
}

// ─── Неймспейсы модуля (ADR-0191) ────────────────────────────────────────────
// Экран и представление объекта ждут их в Suspense области вкладок и контекст-панели,
// слой — в своём: баннер или оверлей не прячут оболочку, пока грузится словарь.

function gateScreen(screen: ScreenDefinition, namespaces: readonly Namespace[]): ScreenDefinition {
  if (namespaces.length === 0) return screen
  const { render, navigator } = screen
  return {
    ...screen,
    render: (tab) => withNamespaces(namespaces, render(tab)),
    ...(navigator ? { navigator: () => withNamespaces(namespaces, navigator()) } : {}),
  }
}

function gateObjectView(
  view: ObjectViewDefinition,
  namespaces: readonly Namespace[],
): ObjectViewDefinition {
  if (namespaces.length === 0) return view
  const { render, contextSection, assistantSection } = view
  return {
    ...view,
    render: (tab) => withNamespaces(namespaces, render(tab)),
    ...(contextSection
      ? {
          contextSection: (objectId: string) =>
            withNamespaces(namespaces, contextSection(objectId)),
        }
      : {}),
    ...(assistantSection
      ? {
          assistantSection: (objectId: string) =>
            withNamespaces(namespaces, assistantSection(objectId)),
        }
      : {}),
  }
}

function gateSlot(
  slot: ShellSlotDefinition,
  namespaces: readonly Namespace[],
): ShellSlotDefinition {
  if (namespaces.length === 0) return slot
  const own = (node: ReactNode) => (
    <Suspense fallback={null}>{withNamespaces(namespaces, node)}</Suspense>
  )
  switch (slot.placement) {
    case 'dialog': {
      const render = slot.render
      return { ...slot, render: (props: ShellDialogProps) => own(render(props)) }
    }
    case 'context-info':
    case 'context-assistant': {
      const render = slot.render
      return { ...slot, render: (objectId: string) => own(render(objectId)) }
    }
    default: {
      const render = slot.render
      return { ...slot, render: () => own(render()) }
    }
  }
}

/** Команды палитры модуля появляются, когда загружен его словарь, — без сырых ключей. */
function gateExtensions(
  given: Partial<ShellExtensions>,
  namespaces: readonly Namespace[],
): Partial<ShellExtensions> {
  if (namespaces.length === 0) return given
  const { usePaletteQuickAction: quickAction, usePaletteCommands: commands } = given
  const gated: Partial<ShellExtensions> = { ...given }
  if (quickAction) {
    gated.usePaletteQuickAction = function usePaletteQuickAction(query) {
      const ready = useNamespacesReady(namespaces)
      const action = quickAction(query)
      return ready ? action : null
    }
  }
  if (commands) {
    gated.usePaletteCommands = function usePaletteCommands() {
      const ready = useNamespacesReady(namespaces)
      const list = commands()
      return ready ? list : []
    }
  }
  return gated
}

/** Пункты навигации модулей по порядку. */
export function listNavItems(): NavItemDefinition[] {
  return [...navItems.values()].sort((a, b) => a.order - b.order)
}

export function getNavItem(key: ScreenKey): NavItemDefinition | undefined {
  return navItems.get(key)
}

/** Возможность модуля или запасной вариант оболочки. */
export function shellExtension<K extends keyof ShellExtensions>(
  key: K,
  fallback: ShellExtensions[K],
): ShellExtensions[K] {
  return (extensions[key] as ShellExtensions[K] | undefined) ?? fallback
}

/** Баннеры или оверлеи модулей. */
export function listShellSlots(
  placement: 'banner' | 'overlay',
): Array<{ key: string; render: () => ReactNode }> {
  return [...slots.values()].flatMap((slot) =>
    slot.placement === placement ? [{ key: slot.key, render: slot.render }] : [],
  )
}

/** Секции контекст-панели модулей для открытого объекта. */
export function listContextSlots(
  placement: 'context-info' | 'context-assistant',
): Array<{ key: string; render: (objectId: string) => ReactNode }> {
  return [...slots.values()].flatMap((slot) =>
    slot.placement === placement ? [{ key: slot.key, render: slot.render }] : [],
  )
}

/** Диалог модуля по ключу, если модуль его зарегистрировал. */
export function getShellDialog(key: string): ((props: ShellDialogProps) => ReactNode) | undefined {
  const slot = slots.get(key)
  return slot?.placement === 'dialog' ? slot.render : undefined
}
