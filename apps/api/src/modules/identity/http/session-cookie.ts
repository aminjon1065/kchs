import { config } from '~/shared/config/index.js'

/** Cookie незавершённого входа: между паролем и вторым фактором. */
export const MFA_COOKIE = 'kchs_mfa'

interface CookieReply {
  setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown
}

/**
 * Cookie сессии (17-security.md §2): HttpOnly, Secure в продакшене, SameSite=Lax.
 * Общая для всех способов входа — пароль, каталог, IdP, ключ входа.
 */
export function setSessionCookie(reply: CookieReply, token: string, expiresAt: string): void {
  const env = config()
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  })
}

/** Cookie вызова второго фактора: живёт десять минут и только до входа. */
export function setMfaCookie(reply: CookieReply, token: string): void {
  reply.setCookie(MFA_COOKIE, token, {
    httpOnly: true,
    secure: config().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })
}
