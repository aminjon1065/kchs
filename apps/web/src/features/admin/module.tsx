import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { AdminModeBanner } from './admin-mode.js'
import { canOpenAdmin } from './sections.js'

/**
 * Что модуль администрирования даёт оболочке (ADR-0183): консоль открывается по любой
 * способности её разделов (N85), режим администратора виден баннером.
 */
export const adminModule: ModuleDefinition = {
  key: 'admin',
  extensions: { canOpenAdmin },
  slots: [{ key: 'admin-mode', placement: 'banner', render: () => <AdminModeBanner /> }],
}
