import type { Locale } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { eq } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { users } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { mailConfigured, sendMail } from '~/shared/mail/index.js'

/**
 * Письмо восстановления доступа. Без SMTP ссылка пишется в лог —
 * это нормальный режим разработки и офлайн-установки.
 */
export async function sendPasswordReset(userId: string, token: string): Promise<void> {
  const env = config()
  const [user] = await db()
    .select({ email: users.email, displayName: users.displayName, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const url = `${env.KCHS_BASE_URL}/reset-password?token=${token}`
  const t = createTranslator((user?.locale as Locale) ?? 'ru')

  if (!mailConfigured() || !user?.email) {
    logger().warn({ userId, url }, 'ссылка восстановления доступа (SMTP не настроен)')
    return
  }

  await sendMail({
    to: user.email,
    subject: t('auth.reset.title'),
    text: `${t('auth.reset.hint')}\n\n${url}\n`,
    html: `<p>${t('auth.reset.hint')}</p><p><a href="${url}">${url}</a></p>`,
  })
}
