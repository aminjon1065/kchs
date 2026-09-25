import type { Capability } from '@kchs/contracts'

/**
 * Разделы консоли и способности, открывающие каждый из них (достаточно любой). Консоль
 * открывается по любой способности своих разделов, лишние разделы скрыты (вопрос N85):
 * «Администратор ГИС» видит подложки и ГИС-службы, «Аудитор безопасности» — журнал и
 * матрицу ролей. Сервер проверяет каждое действие сам.
 */
export const ADMIN_SECTIONS = [
  { value: 'health', capabilities: ['admin.system'] },
  { value: 'users', capabilities: ['users.manage'] },
  { value: 'org', capabilities: ['org.manage'] },
  { value: 'groups', capabilities: ['groups.manage'] },
  // Матрица ролей нужна и аудитору: кто какими способностями владеет
  { value: 'roles', capabilities: ['roles.manage', 'admin.audit.read'] },
  { value: 'spaces', capabilities: ['admin.system'] },
  { value: 'announcements', capabilities: ['admin.system'] },
  { value: 'business-calendar', capabilities: ['admin.system'] },
  { value: 'basemaps', capabilities: ['gis.basemaps.manage'] },
  { value: 'gisServices', capabilities: ['gis.basemaps.manage'] },
  { value: 'dataSources', capabilities: ['data.sources.manage'] },
  { value: 'audit', capabilities: ['admin.audit.read'] },
  { value: 'security', capabilities: ['admin.system'] },
  { value: 'features', capabilities: ['admin.system'] },
  { value: 'branding', capabilities: ['admin.system'] },
  { value: 'backups', capabilities: ['admin.system'] },
  { value: 'directory', capabilities: ['admin.system'] },
  { value: 'sso', capabilities: ['admin.system'] },
  { value: 'tasks', capabilities: ['admin.system'] },
  { value: 'meetings', capabilities: ['admin.system'] },
  { value: 'processes', capabilities: ['processes.manage'] },
  { value: 'integrations', capabilities: ['automation.manage'] },
  { value: 'apiTokens', capabilities: ['admin.system'] },
  { value: 'config', capabilities: ['admin.system'] },
  { value: 'columnar', capabilities: ['admin.system'] },
  { value: 'automation', capabilities: ['automation.manage'] },
  { value: 'schedules', capabilities: ['automation.manage'] },
] as const satisfies ReadonlyArray<{ value: string; capabilities: readonly Capability[] }>

export type AdminSection = (typeof ADMIN_SECTIONS)[number]['value']

/** Разделы, доступные набору способностей, в порядке консоли. */
export function visibleAdminSections(
  capabilities: readonly string[] | undefined,
): Set<AdminSection> {
  const owned = new Set(capabilities ?? [])
  return new Set(
    ADMIN_SECTIONS.filter((section) =>
      section.capabilities.some((capability) => owned.has(capability)),
    ).map((section) => section.value),
  )
}

/** Вход в консоль (рейка, палитра, мобильное меню) — если виден хотя бы один раздел. */
export function canOpenAdmin(capabilities: readonly string[] | undefined): boolean {
  return visibleAdminSections(capabilities).size > 0
}
