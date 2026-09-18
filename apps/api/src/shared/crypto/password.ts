import { hash, verify } from '@node-rs/argon2'

/** Argon2id: память 64 МБ, 3 итерации (17-security.md §2). */
const OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, OPTIONS)
  } catch {
    return false
  }
}

const MIN_LENGTH = 12

/** Простейший локальный словарь частых паролей (расширяется в фазе 5). */
const COMMON = new Set([
  'password',
  'password123',
  'qwerty123456',
  '123456789012',
  'administrator',
  'adminadmin12',
  'welcome12345',
  'letmein12345',
  'iloveyou1234',
  'parolparol1',
])

export interface PasswordCheck {
  ok: boolean
  messageKey?: string
}

export function checkPasswordPolicy(password: string, login?: string): PasswordCheck {
  if (password.length < MIN_LENGTH) return { ok: false, messageKey: 'auth.password.tooShort' }
  if (COMMON.has(password.toLowerCase())) return { ok: false, messageKey: 'auth.password.common' }
  if (login && password.toLowerCase().includes(login.toLowerCase())) {
    return { ok: false, messageKey: 'auth.password.containsLogin' }
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((re) => re.test(password)).length
  if (classes < 2) return { ok: false, messageKey: 'auth.password.tooSimple' }
  return { ok: true }
}
