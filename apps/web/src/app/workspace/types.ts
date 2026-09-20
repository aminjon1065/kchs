/** Ключи экранов оболочки (не привязанных к объекту). */
export type ScreenKey =
  | 'home'
  | 'inbox'
  | 'notifications'
  | 'search'
  | 'files'
  | 'spaces'
  | 'space'
  | 'data'
  | 'maps'
  | 'documents'
  | 'tasks'
  | 'chats'
  | 'meetings'
  | 'calendar'
  | 'knowledge'
  | 'admin'
  | 'profile'
  | 'trash'
  | 'jobs'
  | 'explore'
  | 'sql'
  | 'territories'
  /** Контроль исполнения поручений (ADR-0082). */
  | 'control'
  /** Нагрузка: люди × недели (ADR-0082). */
  | 'workload'
  /** Конструктор маршрута процесса (ADR-0087): параметр `key`. */
  | 'process-designer'
  /** Конструктор правила автоматизации (ADR-0096): параметр `id`. */
  | 'rule-designer'
  /** Редактор офисного файла (ADR-0112): параметр `id` — файл. */
  | 'office-editor'

export interface TabState {
  id: string
  kind: 'screen' | 'object'
  screen?: ScreenKey
  objectId?: string
  objectType?: string
  title: string
  icon?: string
  /** Предварительная вкладка: заменяется следующим одинарным кликом. */
  preview: boolean
  pinned: boolean
  /** Несохранённые изменения — точка на вкладке. */
  dirty: boolean
  /** Цветная группа вкладок. */
  group?: string | null
  params: Record<string, string>
  /** Состояние вкладки: прокрутка, фильтры, выделение, черновики. */
  state: Record<string, unknown>
}

export interface PaneState {
  id: string
  tabIds: string[]
  activeTabId: string | null
  /** Связывание панелей общим фильтром/выделением (ViewContext). */
  linkGroup?: string | null
}

export type ContextTabKey = 'info' | 'links' | 'discussion' | 'activity' | 'assistant'

export interface WorkspaceSnapshot {
  tabs: Record<string, TabState>
  panes: PaneState[]
  focusedPaneId: string
  navigatorOpen: boolean
  contextOpen: boolean
  bottomOpen: boolean
  contextTab: ContextTabKey
  navigatorModule: ScreenKey
  version: 1
}

export interface OpenTabInput {
  kind: 'screen' | 'object'
  screen?: ScreenKey
  objectId?: string
  objectType?: string
  title: string
  icon?: string
  params?: Record<string, string>
  /** `preview` — одинарный клик, `permanent` — двойной клик или правка. */
  mode?: 'preview' | 'permanent' | 'background' | 'split'
  group?: string | null
}
