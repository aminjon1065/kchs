import { createHash } from 'node:crypto'
import {
  type ConfigItem,
  DEFAULT_NUMBER_FORMAT,
  type DocumentDirection,
  type DocumentTypeSettings,
  type JournalReset,
  type LangText,
} from '@kchs/contracts'
import { registerConfigSection } from '~/kernel/config-package/registry.js'
import { directory } from '~/kernel/directory/port.js'
import { getObjectStream, putObject } from '~/kernel/storage/s3.js'
import { fileBriefs, fileStorageKey, registerGeneratedFile } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { type JournalRow, JournalService } from './journal-service.js'
import { documentsSpaceId } from './space.js'
import { DOCX_MIME, DocumentTemplateService, type TemplateRow } from './template-service.js'
import { type DocumentTypeRow, DocumentTypeService } from './type-service.js'

/**
 * Справочники документооборота в пакете конфигурации (ADR-0097, ADR-0206): журналы,
 * типы документов и шаблоны DOCX переносятся между контурами (песочница → рабочий)
 * по стабильным ключам. Ссылки внутри пакета — тоже ключи: журнал нумерации типа —
 * `journalKey`, типы журнала — `typeKeys`, тип шаблона — `typeKey`, маршрут — ключ
 * определения процесса (раздел `processDefinitions` ядра). Подразделения — по коду.
 *
 * Люди не переносятся: в другой установке другие сотрудники. Получатель резолюций
 * «конкретный сотрудник» остаётся местным; новый тип с таким правилом приезжает без
 * него (резолюции не направляются), администратор выбирает сотрудника сам.
 */
const MANAGE = 'documents.journals.manage' as const

/** Файл шаблона едет в пакете, если не больше 2 МБ: пакет — один JSON в пределах тела запроса. */
const TEMPLATE_FILE_LIMIT = 2 * 1024 * 1024

async function unitCodes(): Promise<{ byId: Map<string, string>; byCode: Map<string, string> }> {
  const tree = await directory().orgTree()
  return {
    byId: new Map(tree.map((unit) => [unit.id, unit.code])),
    byCode: new Map(tree.map((unit) => [unit.code, unit.id])),
  }
}

async function typeKeysById(): Promise<Map<string, string>> {
  const rows = await DocumentTypeService.all(db())
  return new Map(rows.map((row) => [row.id, row.key]))
}

async function typeIdsByKey(): Promise<Map<string, string>> {
  const rows = await DocumentTypeService.all(db())
  return new Map(rows.map((row) => [row.key, row.id]))
}

// ── журналы ────────────────────────────────────────────────────────────────

async function journalItem(
  row: JournalRow,
  units: Map<string, string>,
  types: Map<string, string>,
): Promise<ConfigItem> {
  return {
    section: 'journals',
    key: row.key,
    title: row.name,
    updatedAt: row.updatedAt,
    data: {
      name: row.name,
      prefix: row.prefix,
      format: row.format,
      reset: row.reset,
      unitCode: row.unitId ? (units.get(row.unitId) ?? null) : null,
      typeKeys: row.typeIds
        .map((id) => types.get(id))
        .filter((key): key is string => !!key)
        .sort(),
      isActive: row.isActive,
    },
  }
}

interface JournalData {
  name?: string
  prefix?: string
  format?: string
  reset?: JournalReset
  unitCode?: string | null
  typeKeys?: string[]
  isActive?: boolean
}

function resolveTypeIds(keys: string[] | undefined, types: Map<string, string>): string[] {
  return (keys ?? []).map((key) => types.get(key)).filter((id): id is string => !!id)
}

// ── типы документов ────────────────────────────────────────────────────────

function typeItem(
  row: DocumentTypeRow,
  units: Map<string, string>,
  journals: Map<string, string>,
): ConfigItem {
  const { resolutionUserId: _person, ackUnitIds, ...settings } = row.settings
  return {
    section: 'documentTypes',
    key: row.key,
    title: row.name.ru ?? row.key,
    updatedAt: row.updatedAt,
    data: {
      name: row.name,
      direction: row.direction,
      cardSchema: row.cardSchema,
      numbering: {
        journalKey: row.numbering.journalId
          ? (journals.get(row.numbering.journalId) ?? null)
          : null,
        format: row.numbering.format,
      },
      defaultRouteKey: row.defaultRouteKey,
      retentionYears: row.retentionYears,
      confidentialityAllowed: row.confidentialityAllowed,
      defaultConfidentiality: row.defaultConfidentiality,
      printForms: row.printForms,
      settings: {
        ...settings,
        ackUnitCodes: ackUnitIds
          .map((id) => units.get(id))
          .filter((code): code is string => !!code)
          .sort(),
      },
      isActive: row.isActive,
    },
  }
}

interface TypeData {
  name?: LangText
  direction?: DocumentDirection
  cardSchema?: DocumentTypeRow['cardSchema']
  numbering?: { journalKey?: string | null; format?: string | null }
  defaultRouteKey?: string | null
  retentionYears?: number | null
  confidentialityAllowed?: DocumentTypeRow['confidentialityAllowed']
  defaultConfidentiality?: DocumentTypeRow['defaultConfidentiality']
  printForms?: string[]
  settings?: Partial<DocumentTypeSettings> & { ackUnitCodes?: string[] }
  isActive?: boolean
}

/** Настройки типа из пакета с местными людьми и подразделениями. */
function localSettings(
  incoming: TypeData['settings'],
  units: Map<string, string>,
  current: DocumentTypeSettings | null,
): Partial<DocumentTypeSettings> {
  const { ackUnitCodes, resolutionUserId: _ignored, ...rest } = incoming ?? {}
  const settings: Partial<DocumentTypeSettings> = {
    ...rest,
    ackUnitIds: (ackUnitCodes ?? [])
      .map((code) => units.get(code))
      .filter((id): id is string => !!id),
  }
  if (rest.resolutionBy === 'user') {
    // Сотрудник для резолюций — местный: при правке остаётся прежний, у нового типа его нет
    if (current?.resolutionBy === 'user' && current.resolutionUserId) {
      settings.resolutionUserId = current.resolutionUserId
    } else {
      settings.resolutionBy = 'none'
      settings.resolutionUserId = null
    }
  }
  return settings
}

// ── шаблоны ────────────────────────────────────────────────────────────────

async function readFile(storageKey: string): Promise<Buffer> {
  const { body } = await getObjectStream(storageKey)
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

async function templateFile(
  fileId: string | null,
): Promise<{ name: string; size: number; sha256: string; content: string | null } | null> {
  if (!fileId) return null
  const brief = (await fileBriefs([fileId])).get(fileId)
  if (!brief) return null
  if (brief.size > TEMPLATE_FILE_LIMIT) {
    // Без содержимого: хэш неизвестен, сверка — по имени и размеру
    return { name: brief.name, size: brief.size, sha256: '', content: null }
  }
  try {
    const data = await readFile(brief.storageKey)
    return {
      name: brief.name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      content: data.toString('base64'),
    }
  } catch (error) {
    logger().child({ module: 'documents' }).warn({ err: error, fileId }, 'файл шаблона не прочитан')
    return null
  }
}

async function templateItem(row: TemplateRow, types: Map<string, string>): Promise<ConfigItem> {
  return {
    section: 'documentTemplates',
    key: row.key,
    title: row.name,
    updatedAt: row.updatedAt,
    data: {
      name: row.name,
      description: row.description,
      typeKey: row.typeId ? (types.get(row.typeId) ?? null) : null,
      defaults: row.defaults,
      isActive: row.isActive,
      file: await templateFile(row.fileId),
    },
  }
}

interface TemplateData {
  name?: string
  description?: string | null
  typeKey?: string | null
  defaults?: Record<string, unknown>
  isActive?: boolean
  file?: { name: string; size: number; sha256: string; content: string | null } | null
}

/** Файл шаблона из пакета — новое вложение шаблона и разбор плейсхолдеров движком. */
async function attachTemplateFile(
  ctx: UserCtx,
  templateId: string,
  file: NonNullable<TemplateData['file']>,
): Promise<void> {
  if (!file.content) return
  const data = Buffer.from(file.content, 'base64')
  const spaceId = await db().transaction((tx) => documentsSpaceId(tx))
  const fileId = newId()
  const versionId = newId()
  const storageKey = fileStorageKey(spaceId, fileId, versionId, file.name)
  await putObject(storageKey, data, { contentType: DOCX_MIME, contentLength: data.length })
  await db().transaction(async (tx) => {
    await registerGeneratedFile(tx, ctx, {
      fileId,
      versionId,
      spaceId,
      name: file.name,
      mime: DOCX_MIME,
      size: data.length,
      storageKey,
      checksum: null,
      attachToObjectId: templateId,
    })
    await DocumentTemplateService.setFile(tx, ctx, templateId, { fileId })
  })
}

export function registerDocumentConfigSections(): void {
  registerConfigSection({
    section: 'journals',
    capability: MANAGE,
    list: async () => {
      const [{ byId }, types] = await Promise.all([unitCodes(), typeKeysById()])
      const rows = await JournalService.all(db())
      return Promise.all(rows.map((row) => journalItem(row, byId, types)))
    },
    find: async (key) => {
      const row = await JournalService.byKey(db(), key)
      if (!row) return null
      const [{ byId }, types] = await Promise.all([unitCodes(), typeKeysById()])
      return journalItem(row, byId, types)
    },
    apply: async (ctx, item) => {
      const data = item.data as JournalData
      const [{ byCode }, types] = await Promise.all([unitCodes(), typeIdsByKey()])
      const unitId = data.unitCode ? (byCode.get(data.unitCode) ?? null) : null
      const typeIds = resolveTypeIds(data.typeKeys, types)
      const existing = await JournalService.byKey(db(), item.key)
      if (existing) {
        await db().transaction((tx) =>
          JournalService.update(tx, ctx, existing.id, {
            name: data.name ?? item.title,
            ...(data.prefix !== undefined ? { prefix: data.prefix } : {}),
            ...(data.format ? { format: data.format } : {}),
            ...(data.reset ? { reset: data.reset } : {}),
            unitId,
            typeIds,
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          }),
        )
        return 'updated'
      }
      await db().transaction((tx) =>
        JournalService.create(tx, ctx, {
          key: item.key,
          name: data.name ?? item.title,
          prefix: data.prefix ?? '',
          format: data.format || DEFAULT_NUMBER_FORMAT,
          reset: data.reset ?? 'year',
          unitId,
          typeIds,
        }),
      )
      return 'created'
    },
    // Типы, приехавшие в том же пакете, существуют только после их раздела
    relink: async (ctx, item) => {
      const data = item.data as JournalData
      const journal = await JournalService.byKey(db(), item.key)
      if (!journal) return
      const typeIds = resolveTypeIds(data.typeKeys, await typeIdsByKey())
      const same =
        typeIds.length === journal.typeIds.length &&
        typeIds.every((id) => journal.typeIds.includes(id))
      if (same) return
      await db().transaction((tx) => JournalService.update(tx, ctx, journal.id, { typeIds }))
    },
  })

  registerConfigSection({
    section: 'documentTypes',
    capability: MANAGE,
    list: async () => {
      const [{ byId }, journals] = await Promise.all([unitCodes(), JournalService.all(db())])
      const journalKeys = new Map(journals.map((row) => [row.id, row.key]))
      const rows = await DocumentTypeService.all(db())
      return rows.map((row) => typeItem(row, byId, journalKeys))
    },
    find: async (key) => {
      const row = await DocumentTypeService.byKey(db(), key)
      if (!row) return null
      const [{ byId }, journals] = await Promise.all([unitCodes(), JournalService.all(db())])
      return typeItem(row, byId, new Map(journals.map((journal) => [journal.id, journal.key])))
    },
    apply: async (ctx, item) => {
      const data = item.data as TypeData
      const { byCode } = await unitCodes()
      const journal = data.numbering?.journalKey
        ? await JournalService.byKey(db(), data.numbering.journalKey)
        : null
      const numbering = { journalId: journal?.id ?? null, format: data.numbering?.format ?? null }
      const existing = await DocumentTypeService.byKey(db(), item.key)
      if (existing) {
        await db().transaction((tx) =>
          DocumentTypeService.update(tx, ctx, existing.id, {
            ...(data.name ? { name: data.name } : {}),
            ...(data.cardSchema ? { cardSchema: data.cardSchema } : {}),
            numbering,
            defaultRouteKey: data.defaultRouteKey ?? null,
            retentionYears: data.retentionYears ?? null,
            ...(data.confidentialityAllowed
              ? { confidentialityAllowed: data.confidentialityAllowed }
              : {}),
            ...(data.defaultConfidentiality
              ? { defaultConfidentiality: data.defaultConfidentiality }
              : {}),
            ...(data.printForms ? { printForms: data.printForms } : {}),
            settings: localSettings(data.settings, byCode, existing.settings),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          }),
        )
        return 'updated'
      }
      await db().transaction((tx) =>
        DocumentTypeService.create(tx, ctx, {
          key: item.key,
          name: data.name ?? { ru: item.title },
          direction: data.direction ?? 'internal',
          cardSchema: data.cardSchema ?? { fields: [] },
          numbering,
          defaultRouteKey: data.defaultRouteKey ?? null,
          retentionYears: data.retentionYears ?? null,
          confidentialityAllowed: data.confidentialityAllowed ?? [
            'public',
            'internal',
            'confidential',
          ],
          defaultConfidentiality: data.defaultConfidentiality ?? 'internal',
          printForms: data.printForms ?? [],
          settings: localSettings(data.settings, byCode, null) as DocumentTypeSettings,
        }),
      )
      return 'created'
    },
  })

  registerConfigSection({
    section: 'documentTemplates',
    capability: MANAGE,
    list: async () => {
      const types = await typeKeysById()
      const rows = await DocumentTemplateService.all(db())
      return Promise.all(rows.map((row) => templateItem(row, types)))
    },
    find: async (key) => {
      const row = await DocumentTemplateService.byKey(db(), key)
      return row ? templateItem(row, await typeKeysById()) : null
    },
    apply: async (ctx, item) => {
      const data = item.data as TemplateData
      const type = data.typeKey ? await DocumentTypeService.byKey(db(), data.typeKey) : null
      const existing = await DocumentTemplateService.byKey(db(), item.key)
      let templateId: string
      let action: 'created' | 'updated'
      let currentSha: string | null = null
      if (existing) {
        currentSha = (await templateFile(existing.fileId))?.sha256 ?? null
        await db().transaction((tx) =>
          DocumentTemplateService.update(tx, ctx, existing.id, {
            name: data.name ?? item.title,
            description: data.description ?? null,
            typeId: type?.id ?? null,
            defaults: data.defaults ?? {},
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          }),
        )
        templateId = existing.id
        action = 'updated'
      } else {
        templateId = await db().transaction((tx) =>
          DocumentTemplateService.create(tx, ctx, {
            key: item.key,
            name: data.name ?? item.title,
            description: data.description ?? null,
            typeId: type?.id ?? null,
            defaults: data.defaults ?? {},
          }),
        )
        action = 'created'
      }
      if (data.file?.content && data.file.sha256 !== currentSha) {
        await attachTemplateFile(ctx, templateId, data.file)
      }
      return action
    },
  })
}
