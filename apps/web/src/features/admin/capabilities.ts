import type { Capability } from '@kchs/contracts'

/**
 * Строки матрицы «Роли и способности» (15-admin-operations.md): способности
 * по группам. Новая способность в контрактах обязана попасть в группу —
 * это проверяет unit-тест.
 */
export const CAPABILITY_GROUPS: ReadonlyArray<{
  key: 'org' | 'documents' | 'data' | 'system' | 'work'
  capabilities: readonly Capability[]
}> = [
  {
    key: 'org',
    capabilities: ['users.manage', 'org.manage', 'groups.manage', 'roles.manage', 'spaces.create'],
  },
  { key: 'documents', capabilities: ['documents.register', 'documents.journals.manage'] },
  { key: 'data', capabilities: ['data.sources.manage', 'data.export', 'gis.basemaps.manage'] },
  {
    key: 'system',
    capabilities: [
      'admin.system',
      'admin.audit.read',
      'admin.impersonate',
      'automation.manage',
      'api_tokens.create',
    ],
  },
  { key: 'work', capabilities: ['share_links.create', 'ai.use', 'meetings.record'] },
]

/** Ключ подписи в словаре: `admin.audit.read` → `admin.capabilities.adminAuditRead`. */
export function capabilityLabelKey(capability: string): string {
  return `admin.capabilities.${capability.replace(/[._]([a-z])/g, (_, letter: string) => letter.toUpperCase())}`
}
