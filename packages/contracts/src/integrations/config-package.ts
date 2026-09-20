import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'

/**
 * Пакет конфигурации (14-automation-integrations.md §6, ADR-0097): перенос
 * настройки между контурами. Идентификаторы внутри пакета — стабильные ключи
 * (`key`), не UUID: в другой инсталляции UUID другие.
 */
export const CONFIG_SECTIONS = [
  'integrations',
  'webhooks',
  'documentTypes',
  'processDefinitions',
] as const
export const ConfigSection = z.enum(CONFIG_SECTIONS)
export type ConfigSection = z.infer<typeof ConfigSection>

/** Одна запись пакета: раздел, стабильный ключ, название и тело. */
export const ConfigItem = z.object({
  section: ConfigSection,
  key: z.string().min(1).max(200),
  title: z.string(),
  /** Когда запись меняли в исходной установке — для поиска конфликтов. */
  updatedAt: Timestamp.nullable().default(null),
  data: z.record(z.string(), z.unknown()),
})
export type ConfigItem = z.infer<typeof ConfigItem>

export const CONFIG_PACKAGE_VERSION = 1

export const ConfigPackage = z.object({
  /** Версия формата пакета: несовместимый пакет не импортируется. */
  version: z.literal(CONFIG_PACKAGE_VERSION),
  exportedAt: Timestamp,
  /** Откуда выгружено — только для человека. */
  origin: z.object({ baseUrl: z.string(), appVersion: z.string() }),
  sections: z.array(ConfigSection),
  items: z.array(ConfigItem),
})
export type ConfigPackage = z.infer<typeof ConfigPackage>

export const ConfigExportInput = z.object({
  sections: z.array(ConfigSection).min(1),
  /** Ограничить выгрузку конкретными ключами раздела. */
  keys: z.array(z.string()).max(500).optional(),
})
export type ConfigExportInput = z.infer<typeof ConfigExportInput>

export const ConfigDiffStatus = z.enum(['new', 'changed', 'same', 'conflict', 'unsupported'])
export type ConfigDiffStatus = z.infer<typeof ConfigDiffStatus>

export const ConfigDiffEntry = z.object({
  section: ConfigSection,
  key: z.string(),
  title: z.string(),
  status: ConfigDiffStatus,
  /** Поля, которые изменятся при импорте. */
  changedFields: z.array(z.string()),
  /** Почему запись нельзя применить (`conflict`, `unsupported`). */
  reason: z.string().nullable(),
})
export type ConfigDiffEntry = z.infer<typeof ConfigDiffEntry>

export const ConfigImportPreview = z.object({
  version: z.number().int(),
  exportedAt: Timestamp,
  origin: z.object({ baseUrl: z.string(), appVersion: z.string() }),
  entries: z.array(ConfigDiffEntry),
  counts: z.object({
    new: z.number().int(),
    changed: z.number().int(),
    same: z.number().int(),
    conflict: z.number().int(),
    unsupported: z.number().int(),
  }),
})
export type ConfigImportPreview = z.infer<typeof ConfigImportPreview>

export const ConfigImportInput = z.object({
  package: ConfigPackage,
  /** Применять только эти ключи (`<section>:<key>`); пусто — всё применимое. */
  only: z.array(z.string()).max(1000).optional(),
  /** Перезаписывать записи, которые правили здесь (`conflict`). */
  overwriteConflicts: z.boolean().default(false),
})
export type ConfigImportInput = z.infer<typeof ConfigImportInput>

export const ConfigImportResult = z.object({
  applied: z.array(z.object({ section: ConfigSection, key: z.string(), action: z.string() })),
  skipped: z.array(z.object({ section: ConfigSection, key: z.string(), reason: z.string() })),
})
export type ConfigImportResult = z.infer<typeof ConfigImportResult>
