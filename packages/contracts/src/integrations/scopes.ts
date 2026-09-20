import { z } from 'zod'

/**
 * Области доступа токена интеграции (14-automation-integrations.md §3, ADR-0097).
 *
 * Область = `<действие>:<ресурс>`, где ресурс совпадает с тегом маршрута
 * публичного API. Токен не расширяет права человека: сначала проверяется
 * область, затем обычный `authorize()` от имени владельца токена.
 */
export const API_SCOPE_RESOURCES = [
  'objects',
  'views',
  'datasets',
  'gis',
  'documents',
  'tasks',
  'files',
  'reports',
  'calendar',
  'processes',
  'spaces',
  'org',
  'discussions',
  'chat',
  'knowledge',
  'meetings',
  'notifications',
  'search',
  'jobs',
  'integrations',
  'automation',
] as const
export const ApiScopeResource = z.enum(API_SCOPE_RESOURCES)
export type ApiScopeResource = z.infer<typeof ApiScopeResource>

/** Ресурсы только для чтения: записывать через публичный API нечего. */
export const READ_ONLY_SCOPE_RESOURCES: readonly ApiScopeResource[] = ['search', 'jobs']

export const API_SCOPES = [
  'read:objects',
  'write:objects',
  'read:views',
  'write:views',
  'read:datasets',
  'write:datasets',
  'read:gis',
  'write:gis',
  'read:documents',
  'write:documents',
  'read:tasks',
  'write:tasks',
  'read:files',
  'write:files',
  'read:reports',
  'write:reports',
  'read:calendar',
  'write:calendar',
  'read:processes',
  'write:processes',
  'read:spaces',
  'write:spaces',
  'read:org',
  'write:org',
  'read:discussions',
  'write:discussions',
  'read:chat',
  'write:chat',
  'read:knowledge',
  'write:knowledge',
  'read:meetings',
  'write:meetings',
  'read:notifications',
  'write:notifications',
  'read:search',
  'read:jobs',
  'read:integrations',
  'write:integrations',
  'read:automation',
  'write:automation',
] as const
export const ApiScope = z.enum(API_SCOPES)
export type ApiScope = z.infer<typeof ApiScope>

export function scopeOf(mode: 'read' | 'write', resource: ApiScopeResource): ApiScope {
  return `${mode}:${resource}` as ApiScope
}

/** Запись подразумевает чтение того же ресурса: отдельная отметка не нужна. */
export function scopeSatisfied(granted: readonly string[], required: ApiScope): boolean {
  if (granted.includes(required)) return true
  if (!required.startsWith('read:')) return false
  return granted.includes(`write:${required.slice('read:'.length)}`)
}
