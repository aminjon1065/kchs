import { resolve } from 'node:path'
import { BASEMAP_PRESETS } from '@kchs/contracts'
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

/**
 * `kchs basemaps add <ключ…>` — подложки из каталога (ADR-0196): спутник Sentinel-2,
 * топографическая OpenTopoMap. Уже добавленные пропускаются.
 */
export async function runBasemapsAdd(
  keys: string[],
): Promise<Array<{ key: string; name: string; created: boolean }>> {
  registerAllObjectTypes()
  const ctx = systemCtx('kchs-basemaps')
  const added = []
  for (const key of keys) added.push({ key, ...(await BasemapService.addPreset(ctx, key)) })
  return added
}

export function formatPresets(): string {
  return `${BASEMAP_PRESETS.map((preset) => `  ${preset.key.padEnd(12)} ${preset.name}`).join('\n')}\n`
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
