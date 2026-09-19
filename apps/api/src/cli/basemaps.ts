import { resolve } from 'node:path'
import {
  BasemapService,
  type BasemapSyncSummary,
  type UploadSummary,
  uploadBasemapBuild,
} from '~/modules/gis/public.js'
import { registerAllObjectTypes } from '~/modules/index.js'
import { systemCtx } from '~/shared/context.js'

/**
 * `kchs basemaps upload | sync` — базовые карты установки (15-admin-operations.md,
 * ADR-0066): сборка `infra/basemaps/build-pmtiles.sh` → бакет тайлов → реестр.
 */
export async function runBasemapsUpload(
  directory: string,
  options: { key?: string; register: boolean; log: (line: string) => void },
): Promise<{ upload: UploadSummary; sync: BasemapSyncSummary | null }> {
  const upload = await uploadBasemapBuild(resolve(directory), {
    key: options.key,
    log: options.log,
  })
  const sync = options.register ? await runBasemapsSync() : null
  return { upload, sync }
}

export function runBasemapsSync(): Promise<BasemapSyncSummary> {
  // Подложка — объект реестра: ObjectService создаёт только зарегистрированные типы
  registerAllObjectTypes()
  return BasemapService.sync(systemCtx('kchs-basemaps'))
}

export function formatSyncSummary(summary: BasemapSyncSummary): string {
  const lines = [
    summary.created.length > 0
      ? `  Зарегистрированы: ${summary.created.join(', ')}`
      : '  Новых подложек нет',
  ]
  if (summary.updated.length > 0) {
    lines.push(`  Новая версия сборки: ${summary.updated.join(', ')}`)
  }
  lines.push(`  По умолчанию: ${summary.defaultName ?? '—'}`)
  if (!summary.storageAvailable) {
    lines.push('  Хранилище недоступно — сборки не проверены, повторите `kchs basemaps sync`')
  }
  return `${lines.join('\n')}\n`
}
