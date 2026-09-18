import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Именованное рабочее пространство (12-calendar-notifications-home.md, 03-ui §8):
 * набор вкладок и разделений, который сохраняется и открывается одним действием,
 * может быть общим. Хранится объектом реестра `view` с `objectType = 'workspace'`.
 */
export const WORKSPACE_VIEW_TYPE = 'workspace'

export const WorkspaceTab = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['screen', 'object']),
  screen: z.string().max(32).optional(),
  objectId: Uuid.optional(),
  objectType: z.string().max(64).optional(),
  title: z.string().max(500),
  icon: z.string().max(64).optional(),
  pinned: z.boolean().default(false),
  group: z.string().max(32).nullable().optional(),
  params: z.record(z.string(), z.string()).default({}),
  /** Состояние вкладки (фильтры, режим списка) — открывается как было сохранено. */
  state: z.record(z.string(), z.unknown()).default({}),
})
export type WorkspaceTab = z.infer<typeof WorkspaceTab>

export const WorkspacePane = z.object({
  id: z.string().min(1).max(64),
  tabIds: z.array(z.string().min(1).max(64)).max(50),
  activeTabId: z.string().max(64).nullable(),
  linkGroup: z.string().max(32).nullable().optional(),
})

export const WorkspaceLayout = z
  .object({
    version: z.literal(1),
    tabs: z.record(z.string(), WorkspaceTab),
    panes: z.array(WorkspacePane).min(1).max(4),
    focusedPaneId: z.string().min(1).max(64),
    contextOpen: z.boolean().default(true),
    contextTab: z.enum(['info', 'links', 'discussion', 'activity', 'assistant']).default('info'),
  })
  .refine((layout) => Object.keys(layout.tabs).length <= 60, {
    message: 'Не больше 60 вкладок',
  })
  .refine((layout) => layout.panes.every((pane) => pane.tabIds.every((id) => id in layout.tabs)), {
    message: 'Панель ссылается на отсутствующую вкладку',
  })
export type WorkspaceLayout = z.infer<typeof WorkspaceLayout>

export const NamedWorkspace = z.object({
  id: Uuid,
  title: z.string(),
  spaceId: Uuid.nullable(),
  ownerId: Uuid.nullable(),
  shared: z.boolean(),
  pinned: z.boolean(),
  layout: WorkspaceLayout,
  updatedAt: z.string(),
})
export type NamedWorkspace = z.infer<typeof NamedWorkspace>

/** Список без раскладки — для меню и палитры команд. */
export const NamedWorkspaceSummary = NamedWorkspace.omit({ layout: true }).extend({
  tabCount: z.number().int(),
})
export type NamedWorkspaceSummary = z.infer<typeof NamedWorkspaceSummary>

export const NamedWorkspaceInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** Общее — в пространстве команды, видно его участникам; личное — в личном пространстве. */
  shared: z.boolean().default(false),
  spaceId: Uuid.nullable().optional(),
  layout: WorkspaceLayout,
})
export type NamedWorkspaceInput = z.infer<typeof NamedWorkspaceInput>

export const NamedWorkspacePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  layout: WorkspaceLayout.optional(),
})
export type NamedWorkspacePatch = z.infer<typeof NamedWorkspacePatch>
