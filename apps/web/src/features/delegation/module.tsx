import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { ActingBanner } from './acting-banner.js'

/** Что модуль замещений даёт оболочке (ADR-0183): баннер работы «от имени». */
export const delegationModule: ModuleDefinition = {
  key: 'delegation',
  slots: [{ key: 'acting', placement: 'banner', render: () => <ActingBanner /> }],
}
