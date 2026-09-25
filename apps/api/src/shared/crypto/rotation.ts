import { getTableName, sql } from 'drizzle-orm'
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import {
  authProviders,
  basemaps,
  calendars,
  integrations,
  mailMailboxes,
  mfaFactors,
  serviceLayers,
  ssoAuthRequests,
  webhooks,
} from '../db/schema/index.js'
import { reencryptSecret } from './secrets.js'

interface EncryptedColumn {
  table: AnyPgTable
  id: AnyPgColumn
  column: AnyPgColumn
  /** Что это для человека — строка отчёта команды. */
  label: string
}

/**
 * Всё, что зашифровано мастер-ключом в базе (17-security.md §4, ADR-0143). Новая
 * зашифрованная колонка добавляется сюда — иначе смена ключа сделает её нечитаемой;
 * тест `secrets-rotation.test.ts` сверяет список с колонками схемы вида `bytea`.
 * Временные пароли импорта сотрудников живут в Redis часы — их читает прежний ключ.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    table: integrations,
    id: integrations.id,
    column: integrations.secrets,
    label: 'Секреты интеграций',
  },
  { table: webhooks, id: webhooks.id, column: webhooks.secret, label: 'Подписи вебхуков' },
  {
    table: mailMailboxes,
    id: mailMailboxes.id,
    column: mailMailboxes.secretEnc,
    label: 'Пароль ящика канцелярии',
  },
  { table: basemaps, id: basemaps.id, column: basemaps.secretEnc, label: 'Ключи базовых карт' },
  {
    table: serviceLayers,
    id: serviceLayers.id,
    column: serviceLayers.secretEnc,
    label: 'Ключи ГИС-служб',
  },
  {
    table: calendars,
    id: calendars.id,
    column: calendars.sourceEnc,
    label: 'Адреса подписок на календари',
  },
  {
    table: mfaFactors,
    id: mfaFactors.id,
    column: mfaFactors.secretEnc,
    label: 'Секреты второго фактора',
  },
  {
    table: authProviders,
    id: authProviders.kind,
    column: authProviders.secretEnc,
    label: 'Секреты каталога и единого входа',
  },
  {
    table: ssoAuthRequests,
    id: ssoAuthRequests.id,
    column: ssoAuthRequests.codeVerifierEnc,
    label: 'Незавершённые входы через IdP',
  },
]

export interface RotationLine {
  label: string
  table: string
  rotated: number
  current: number
  unreadable: number
}

const BATCH = 500

/**
 * Перешифрование текущим мастер-ключом (`kchs secrets rotate`). Идёт пачками по
 * первичному ключу; каждая строка обновляется отдельно, поэтому прерванный прогон
 * безопасно повторить: уже перешифрованное считается «текущим». Не читаемое ни
 * текущим, ни прежним ключом не трогается и попадает в отчёт.
 */
export async function rotateSecrets(options: { dryRun: boolean }): Promise<RotationLine[]> {
  const report: RotationLine[] = []
  for (const spec of ENCRYPTED_COLUMNS) {
    const table = getTableName(spec.table)
    const line: RotationLine = { label: spec.label, table, rotated: 0, current: 0, unreadable: 0 }
    let after: string | null = null
    for (;;) {
      const rows: Array<{ id: string; value: Buffer }> = await db().execute<{
        id: string
        value: Buffer
      }>(sql`
        SELECT ${sql.identifier(spec.id.name)}::text AS id, ${sql.identifier(spec.column.name)} AS value
          FROM ${sql.identifier(table)}
         WHERE ${sql.identifier(spec.column.name)} IS NOT NULL
           ${after === null ? sql`` : sql`AND ${sql.identifier(spec.id.name)}::text > ${after}`}
         ORDER BY ${sql.identifier(spec.id.name)}::text
         LIMIT ${BATCH}`)
      if (rows.length === 0) break
      for (const row of rows) {
        const outcome = reencryptSecret(row.value)
        if (outcome.state === 'current') line.current += 1
        else if (outcome.state === 'unreadable') line.unreadable += 1
        else {
          line.rotated += 1
          if (!options.dryRun) {
            await db().execute(sql`
              UPDATE ${sql.identifier(table)}
                 SET ${sql.identifier(spec.column.name)} = ${outcome.payload}
               WHERE ${sql.identifier(spec.id.name)}::text = ${row.id}`)
          }
        }
      }
      after = rows[rows.length - 1]?.id ?? null
      if (rows.length < BATCH) break
    }
    report.push(line)
  }
  return report
}

export function formatRotation(report: readonly RotationLine[], dryRun: boolean): string {
  const lines = report.map(
    (line) =>
      `  ${line.label}: ${dryRun ? 'будет перешифровано' : 'перешифровано'} ${line.rotated}, уже текущим ключом ${line.current}` +
      (line.unreadable > 0 ? `, НЕ ЧИТАЕТСЯ ни одним ключом ${line.unreadable}` : ''),
  )
  const unreadable = report.reduce((sum, line) => sum + line.unreadable, 0)
  const tail =
    unreadable > 0
      ? '\nЕсть секреты, которые не читаются ни текущим, ни прежним ключом: проверьте KCHS_MASTER_KEY_PREVIOUS. Такие строки не изменены.\n'
      : dryRun
        ? '\nПробный прогон: ничего не изменено.\n'
        : '\nГотово. Уберите KCHS_MASTER_KEY_PREVIOUS из окружения и перезапустите api и worker.\n'
  return `${dryRun ? 'Смена мастер-ключа — пробный прогон' : 'Смена мастер-ключа'}:\n${lines.join('\n')}\n${tail}`
}
