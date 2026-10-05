import { afterEach, describe, expect, it } from 'vitest'
import { resetConfigCache } from '../../config/env.js'
import { issueJobToken, JOB_TOKEN_TTL_MS, verifyJobToken } from '../job-token.js'

const JOB = '0199b2c3-d4e5-7f60-8a1b-2c3d4e5f6a7b'
const ORIGINAL_KEY = process.env.KCHS_MASTER_KEY

function useKeys(current: string, previous?: string): void {
  process.env.KCHS_MASTER_KEY = current
  if (previous) process.env.KCHS_MASTER_KEY_PREVIOUS = previous
  else delete process.env.KCHS_MASTER_KEY_PREVIOUS
  resetConfigCache()
}

afterEach(() => {
  if (ORIGINAL_KEY) process.env.KCHS_MASTER_KEY = ORIGINAL_KEY
  delete process.env.KCHS_MASTER_KEY_PREVIOUS
  resetConfigCache()
})

/** Токен обратного вызова задания движка (ADR-0176). */
describe('токен задания движка', () => {
  it('открывает своё задание и свой ресурс', () => {
    expect(verifyJobToken(issueJobToken({ jobId: JOB, scope: 'file:42' }))).toMatchObject({
      jobId: JOB,
      scope: 'file:42',
    })
    expect(verifyJobToken(issueJobToken({ jobId: JOB }))).toMatchObject({ jobId: JOB, scope: '' })
  })

  it('истёкший не принимается', () => {
    const issued = Date.now() - JOB_TOKEN_TTL_MS - 1_000
    expect(verifyJobToken(issueJobToken({ jobId: JOB }, issued))).toBeNull()
  })

  it('подменённые задание или ресурс ломают подпись', () => {
    const [version, , signature] = issueJobToken({ jobId: JOB, scope: 'file:42' }).split('.')
    const forged = Buffer.from(
      JSON.stringify({ j: JOB, s: 'file:43', e: Math.floor(Date.now() / 1000) + 3_600 }),
    ).toString('base64url')
    expect(verifyJobToken(`${version}.${forged}.${signature}`)).toBeNull()
  })

  it('мусор и общий сервисный токен не принимаются', () => {
    const token = issueJobToken({ jobId: JOB })
    for (const value of [
      undefined,
      ['v1'],
      '',
      'v1',
      `${token}.лишнее`,
      token.replace(/^v1\./, 'v2.'),
      process.env.INTERNAL_SERVICE_TOKEN ?? 'service-token',
    ]) {
      expect(verifyJobToken(value)).toBeNull()
    }
  })

  it('выданный прежним мастер-ключом принимается, пока идёт смена ключа', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64')
    const newKey = Buffer.alloc(32, 9).toString('base64')
    useKeys(oldKey)
    const token = issueJobToken({ jobId: JOB, scope: 'import:1' })
    useKeys(newKey, oldKey)
    expect(verifyJobToken(token)).toMatchObject({ scope: 'import:1' })
    useKeys(newKey)
    expect(verifyJobToken(token)).toBeNull()
  })
})
