import { getTableName, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Смена мастер-ключа (N81, ADR-0143): с прежним ключом в `KCHS_MASTER_KEY_PREVIOUS`
 * секреты читаются, `kchs secrets rotate` перешифровывает их текущим, повторный прогон
 * ничего не меняет, не читаемое ни одним ключом не трогается. Список зашифрованных
 * колонок сверяется со схемой: новая колонка `bytea` без решения не пройдёт.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')
const { decryptSecret } = await import('../src/shared/crypto/secrets.js')
const { ENCRYPTED_COLUMNS, rotateSecrets } = await import('../src/shared/crypto/rotation.js')

/**
 * Колонки `bytea` схемы `public`, в которых не секреты: публичный ключ входа. Состояние
 * совместных документов лежит в схеме `yjs` и сверкой не охватывается.
 */
const NOT_SECRETS = new Set(['webauthn_credentials.public_key'])

const ORIGINAL = process.env.KCHS_MASTER_KEY as string
const NEW_KEY = Buffer.alloc(32, 7).toString('base64')

function useKeys(current: string, previous: string | undefined): void {
  process.env.KCHS_MASTER_KEY = current
  if (previous) process.env.KCHS_MASTER_KEY_PREVIOUS = previous
  else delete process.env.KCHS_MASTER_KEY_PREVIOUS
  resetConfigCache()
}

async function secretsOf(id: string): Promise<Buffer> {
  const [row] = await db().execute<{ secrets: Buffer }>(
    sql`SELECT secrets FROM integrations WHERE id = ${id}`,
  )
  return row?.secrets as Buffer
}

let fx: TestContext
let integrationId = ''

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: `rotation-${Date.now().toString(36)}`,
      kind: 'http',
      name: 'Смена ключа',
      config: {},
      secrets: { apiKey: 'секрет-до-смены' },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  integrationId = created.json().id
})

afterAll(() => useKeys(ORIGINAL, undefined))

describe('смена мастер-ключа', () => {
  it('в списке зашифрованного — каждая колонка bytea схемы, кроме явно не секретных', async () => {
    const rows = await db().execute<{ name: string }>(sql`
      SELECT table_name || '.' || column_name AS name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'bytea'`)
    const listed = new Set(
      ENCRYPTED_COLUMNS.map((spec) => `${getTableName(spec.table)}.${spec.column.name}`),
    )
    const unexplained = rows
      .map((row) => row.name)
      .filter((name) => !listed.has(name) && !NOT_SECRETS.has(name))
    expect(unexplained).toEqual([])
  })

  it('прежний ключ читает, rotate перешифровывает текущим, повтор ничего не меняет', async () => {
    const before = await secretsOf(integrationId)
    useKeys(NEW_KEY, ORIGINAL)
    // До перешифрования секрет читается прежним ключом
    expect(JSON.parse(decryptSecret(before))).toEqual({ apiKey: 'секрет-до-смены' })

    const dry = await rotateSecrets({ dryRun: true })
    const dryLine = dry.find((line) => line.table === 'integrations')
    expect(dryLine?.rotated).toBeGreaterThanOrEqual(1)
    expect((await secretsOf(integrationId)).equals(before)).toBe(true)

    const report = await rotateSecrets({ dryRun: false })
    expect(report.find((line) => line.table === 'integrations')?.rotated).toBeGreaterThanOrEqual(1)
    expect(report.every((line) => line.unreadable === 0)).toBe(true)

    // Прежний ключ больше не нужен: всё читается новым
    useKeys(NEW_KEY, undefined)
    const after = await secretsOf(integrationId)
    expect(after.equals(before)).toBe(false)
    expect(JSON.parse(decryptSecret(after))).toEqual({ apiKey: 'секрет-до-смены' })

    const again = await rotateSecrets({ dryRun: false })
    expect(again.every((line) => line.rotated === 0)).toBe(true)
    expect(again.find((line) => line.table === 'integrations')?.current).toBeGreaterThanOrEqual(1)
  })

  it('не читаемое ни одним ключом не трогается и попадает в отчёт', async () => {
    useKeys(NEW_KEY, ORIGINAL)
    const garbage = Buffer.alloc(48, 1)
    await db().execute(
      sql`UPDATE integrations SET secrets = ${garbage} WHERE id = ${integrationId}`,
    )
    const report = await rotateSecrets({ dryRun: false })
    expect(report.find((line) => line.table === 'integrations')?.unreadable).toBe(1)
    expect((await secretsOf(integrationId)).equals(garbage)).toBe(true)
    await db().execute(sql`DELETE FROM integrations WHERE id = ${integrationId}`)
  })

  it('обратная смена возвращает базу к ключу окружения тестов', async () => {
    useKeys(ORIGINAL, NEW_KEY)
    const report = await rotateSecrets({ dryRun: false })
    expect(report.every((line) => line.unreadable === 0)).toBe(true)
    useKeys(ORIGINAL, undefined)
    const again = await rotateSecrets({ dryRun: true })
    expect(again.every((line) => line.rotated === 0 && line.unreadable === 0)).toBe(true)
  })
})
