import type {
  SourceColumn,
  SourcePreview,
  SourceQuery,
  SourceTable,
  StoredFieldType,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { type IntegrationRow, integrations } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { DATABASE_KINDS, ExternalDatabases } from './database-source.js'
import { readSecrets } from './integration-service.js'

/**
 * Доступ к внешней СУБД по идентификатору интеграции (ADR-0107). Наружу модуля
 * уходит только это: учётные данные остаются здесь и в другие модули не
 * передаются. Право вести интеграции проверяет вызывающий.
 */
async function load(
  integrationId: string,
): Promise<{ row: IntegrationRow; secrets: Record<string, string> }> {
  const [row] = await db()
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1)
  if (!row) throw errors.notFound('Интеграция')
  if (!DATABASE_KINDS.has(row.kind)) {
    throw errors.validation('Выбранная интеграция — не подключение к базе данных')
  }
  if (!row.enabled) throw errors.conflict('Интеграция выключена')
  return { row, secrets: readSecrets(row) }
}

export interface ExternalReadRequest {
  query: SourceQuery
  cursorField?: string | null
  /** Тип поля-курсора: значение хранится текстом и приводится к нему. */
  cursorType?: StoredFieldType | undefined
  cursorValue?: string | null
  limit?: number | null
}

export const ExternalDatabase = {
  /** Виды интеграций, которые можно выбрать источником датасета. */
  kinds: (): string[] => [...DATABASE_KINDS],

  async check(integrationId: string): Promise<{ ok: boolean; message: string }> {
    const { row, secrets } = await load(integrationId)
    return ExternalDatabases.check(row, secrets)
  },

  async tables(integrationId: string): Promise<SourceTable[]> {
    const { row, secrets } = await load(integrationId)
    return ExternalDatabases.tables(row, secrets)
  },

  async preview(integrationId: string, query: SourceQuery, limit: number): Promise<SourcePreview> {
    const { row, secrets } = await load(integrationId)
    return ExternalDatabases.preview(row, secrets, query, limit)
  },

  async columns(integrationId: string, query: SourceQuery): Promise<SourceColumn[]> {
    const { row, secrets } = await load(integrationId)
    return ExternalDatabases.columns(row, secrets, query)
  },

  async stream(
    integrationId: string,
    request: ExternalReadRequest,
    onBatch: (rows: Array<Record<string, unknown>>) => Promise<void>,
    batchSize = 2000,
  ): Promise<void> {
    const { row, secrets } = await load(integrationId)
    return ExternalDatabases.stream(row, secrets, request, onBatch, batchSize)
  },
}

export { externalValue } from './database-source.js'
