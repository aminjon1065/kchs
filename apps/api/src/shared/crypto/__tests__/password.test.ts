import { describe, expect, it } from 'vitest'
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../password.js'
import { decryptSecret, encryptSecret, hashToken, safeEqual } from '../secrets.js'

describe('политика паролей', () => {
  it('короткий пароль отклоняется', () => {
    expect(checkPasswordPolicy('Short1!').ok).toBe(false)
  })

  it('распространённый пароль отклоняется', () => {
    expect(checkPasswordPolicy('password123').ok).toBe(false)
  })

  it('пароль с логином отклоняется', () => {
    expect(checkPasswordPolicy('IvanovPassword2026', 'ivanov').ok).toBe(false)
  })

  it('однородный пароль отклоняется', () => {
    expect(checkPasswordPolicy('абвгдеёжзийкл').ok).toBe(false)
  })

  it('надёжный пароль принимается', () => {
    expect(checkPasswordPolicy('Kchs!Start-2026-7q', 'admin').ok).toBe(true)
  })
})

describe('argon2', () => {
  it('хэш проверяется и не совпадает с исходным', async () => {
    const hash = await hashPassword('Kchs!Start-2026-7q')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword(hash, 'Kchs!Start-2026-7q')).toBe(true)
    expect(await verifyPassword(hash, 'другой пароль')).toBe(false)
  })
})

describe('шифрование секретов', () => {
  it('AES-256-GCM обратимо', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const encrypted = encryptSecret(secret)
    expect(encrypted.length).toBeGreaterThan(secret.length)
    expect(decryptSecret(encrypted)).toBe(secret)
  })

  it('два шифрования одного текста различаются (случайный IV)', () => {
    expect(encryptSecret('x').toString('hex')).not.toBe(encryptSecret('x').toString('hex'))
  })

  it('хэш токена детерминирован', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })

  it('сравнение в постоянное время', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
