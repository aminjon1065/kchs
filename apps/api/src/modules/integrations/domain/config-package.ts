import {
  CONFIG_PACKAGE_VERSION,
  type ConfigDiffEntry,
  type ConfigExportInput,
  type ConfigImportInput,
  type ConfigImportPreview,
  type ConfigImportResult,
  type ConfigItem,
  type ConfigPackage,
  type ConfigSection,
} from '@kchs/contracts'
import { hasCapability } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { configSection, listConfigSections } from '~/kernel/config-package/registry.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/** Разделы, которые эта установка умеет выгружать и применять. */
export function availableSections(): ConfigSection[] {
  return listConfigSections().map((provider) => provider.section)
}

function sameData(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) changed.push(key)
  }
  return changed.sort()
}

export const ConfigPackages = {
  /** Выгружает выбранные разделы в переносимый JSON со стабильными ключами. */
  async exportPackage(ctx: UserCtx, input: ConfigExportInput): Promise<ConfigPackage> {
    const items: ConfigItem[] = []
    const only = input.keys ? new Set(input.keys) : null

    for (const section of input.sections) {
      const provider = configSection(section)
      if (!provider) throw errors.validation(`Раздел «${section}» не поддерживается установкой`)
      if (!hasCapability(ctx, provider.capability)) {
        throw errors.forbidden(`Нет права на раздел «${section}»`)
      }
      for (const item of await provider.list()) {
        if (only && !only.has(item.key) && !only.has(`${section}:${item.key}`)) continue
        items.push(item)
      }
    }

    await audit(ctx, {
      action: AUDIT_ACTIONS.configExported,
      severity: 'notice',
      details: { sections: input.sections, items: items.length },
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'config.exported',
        payload: { sections: [...input.sections], items: items.length },
      })
    })

    return {
      version: CONFIG_PACKAGE_VERSION,
      exportedAt: new Date().toISOString(),
      origin: { baseUrl: config().KCHS_BASE_URL, appVersion: '0.1.0' },
      sections: [...input.sections],
      items,
    }
  },

  /**
   * Предпросмотр различий. Конфликт — запись, которую правили здесь позже,
   * чем её выгрузили: импорт затёр бы свежую местную правку, поэтому такие
   * записи применяются только с явным согласием.
   */
  async preview(ctx: UserCtx, pkg: ConfigPackage): Promise<ConfigImportPreview> {
    if (pkg.version !== CONFIG_PACKAGE_VERSION) {
      throw errors.validation(`Версия пакета ${pkg.version} не поддерживается`)
    }
    const entries: ConfigDiffEntry[] = []
    const exportedAt = Date.parse(pkg.exportedAt)

    for (const item of pkg.items) {
      const provider = configSection(item.section)
      if (!provider || !hasCapability(ctx, provider.capability)) {
        entries.push({
          section: item.section,
          key: item.key,
          title: item.title,
          status: 'unsupported',
          changedFields: [],
          reason: provider ? 'Нет права на раздел' : 'Раздел не поддерживается установкой',
        })
        continue
      }
      const existing = await provider.find(item.key)
      if (!existing) {
        entries.push({
          section: item.section,
          key: item.key,
          title: item.title,
          status: 'new',
          changedFields: [],
          reason: null,
        })
        continue
      }
      const changedFields = sameData(existing.data, item.data)
      if (changedFields.length === 0) {
        entries.push({
          section: item.section,
          key: item.key,
          title: item.title,
          status: 'same',
          changedFields: [],
          reason: null,
        })
        continue
      }
      const localNewer =
        existing.updatedAt !== null &&
        Number.isFinite(exportedAt) &&
        Date.parse(existing.updatedAt) > exportedAt
      entries.push({
        section: item.section,
        key: item.key,
        title: item.title,
        status: localNewer ? 'conflict' : 'changed',
        changedFields,
        reason: localNewer ? 'Запись правили здесь после выгрузки пакета' : null,
      })
    }

    const counts = { new: 0, changed: 0, same: 0, conflict: 0, unsupported: 0 }
    for (const entry of entries) counts[entry.status] += 1
    return {
      version: pkg.version,
      exportedAt: pkg.exportedAt,
      origin: pkg.origin,
      entries,
      counts,
    }
  },

  /** Применяет пакет: только выбранные записи и только применимые. */
  async apply(ctx: UserCtx, input: ConfigImportInput): Promise<ConfigImportResult> {
    const preview = await ConfigPackages.preview(ctx, input.package)
    const only = input.only ? new Set(input.only) : null
    const byKey = new Map(preview.entries.map((e) => [`${e.section}:${e.key}`, e]))

    const applied: ConfigImportResult['applied'] = []
    const skipped: ConfigImportResult['skipped'] = []

    for (const item of input.package.items) {
      const id = `${item.section}:${item.key}`
      const entry = byKey.get(id)
      if (!entry) continue
      if (only && !only.has(id)) {
        skipped.push({ section: item.section, key: item.key, reason: 'not_selected' })
        continue
      }
      if (entry.status === 'unsupported') {
        skipped.push({ section: item.section, key: item.key, reason: 'unsupported' })
        continue
      }
      if (entry.status === 'same') {
        skipped.push({ section: item.section, key: item.key, reason: 'same' })
        continue
      }
      if (entry.status === 'conflict' && !input.overwriteConflicts) {
        skipped.push({ section: item.section, key: item.key, reason: 'conflict' })
        continue
      }
      const provider = configSection(item.section)
      if (!provider) continue
      const action = await provider.apply(ctx, item)
      applied.push({ section: item.section, key: item.key, action })
    }

    const sections = [...new Set(applied.map((a) => a.section))]
    await audit(ctx, {
      action: AUDIT_ACTIONS.configImported,
      severity: 'notice',
      details: {
        origin: input.package.origin,
        applied: applied.map((a) => `${a.section}:${a.key}`),
        skipped: skipped.length,
      },
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'config.imported',
        payload: { sections, applied: applied.length, skipped: skipped.length },
      })
    })
    return { applied, skipped }
  },
}
