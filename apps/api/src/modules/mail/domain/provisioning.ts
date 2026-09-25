import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MailStatus } from '@kchs/contracts'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { UserService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { mailMailboxes } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'

/** Файл учёток docker-mailserver: `адрес|{схема}хеш` построчно, подхватывается без перезапуска. */
const ACCOUNTS_FILE = 'postfix-accounts.cf'
/** Без похожих символов: пароль переписывают в почтовую программу. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Пароль для почты: 4 группы по 5 знаков — около 115 бит, перебор бессмыслен. */
export function mailPassword(): string {
  const groups: string[] = []
  for (let group = 0; group < 4; group += 1) {
    let part = ''
    for (let index = 0; index < 5; index += 1) part += ALPHABET[randomInt(ALPHABET.length)]
    groups.push(part)
  }
  return groups.join('-')
}

/**
 * Хеш `{SSHA512}`, который проверяет Dovecot: base64(sha512(пароль ‖ соль) ‖ соль). Схема
 * быстрая, но пароли для почты случайные и длинные — подбирать их по хешу бесполезно.
 */
export function ssha512(password: string): string {
  const salt = randomBytes(16)
  const digest = createHash('sha512')
    .update(Buffer.concat([Buffer.from(password), salt]))
    .digest()
  return `{SSHA512}${Buffer.concat([digest, salt]).toString('base64')}`
}

function domain(): string {
  return config().MAIL_DOMAIN.trim().toLowerCase()
}

function registryAddress(): string {
  return `${config().MAIL_REGISTRY_LOCAL.trim().toLowerCase()}@${domain()}`
}

/** Адрес ящика сотрудника — по логину: логины платформы — латиница, цифры, «._-». */
function personAddress(login: string): string {
  return `${login.toLowerCase()}@${domain()}`
}

async function activePeople(): Promise<Array<{ id: string; login: string }>> {
  const people: Array<{ id: string; login: string }> = []
  let cursor: string | undefined
  do {
    const page = await UserService.list({
      status: 'active',
      kind: 'person',
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    for (const user of page.items) people.push({ id: user.id, login: user.login })
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return people
}

async function writeAccounts(lines: string[]): Promise<string | null> {
  const dir = config().MAIL_CONFIG_DIR.trim()
  if (!dir) return null
  const target = resolve(dir)
  await mkdir(target, { recursive: true })
  const file = join(target, ACCOUNTS_FILE)
  const temp = `${file}.${process.pid}.tmp`
  // Целиком и заменой: сервер не должен прочитать файл наполовину записанным
  await writeFile(temp, `${lines.join('\n')}\n`, { mode: 0o640 })
  await rename(temp, file)
  return file
}

/**
 * Почтовые ящики установки (ADR-0150): ящик у каждого действующего сотрудника (по логину)
 * и общий ящик канцелярии. Платформа ведёт их сама и пишет файл учёток почтового сервера;
 * заблокированный сотрудник из файла пропадает — почта ему не принимается, вход закрыт.
 */
export const MailProvisioning = {
  enabled(): boolean {
    return domain().length > 0
  },

  async status(ctx: UserCtx): Promise<MailStatus> {
    if (!MailProvisioning.enabled()) {
      return { enabled: false, address: null, passwordSet: false, webmailUrl: null }
    }
    const [row] = await db()
      .select({ address: mailMailboxes.address, passwordSet: mailMailboxes.passwordSet })
      .from(mailMailboxes)
      .where(eq(mailMailboxes.userId, ctx.userId))
      .limit(1)
    const self = await UserService.profile(ctx.userId)
    return {
      enabled: true,
      address: row?.address ?? (self ? personAddress(self.login) : null),
      passwordSet: Boolean(row?.passwordSet),
      webmailUrl: config().MAIL_WEBMAIL_URL || null,
    }
  },

  /** Новый пароль для почты — показывается один раз; прежний перестаёт действовать. */
  async setPassword(ctx: UserCtx): Promise<{ address: string; password: string }> {
    if (!MailProvisioning.enabled()) throw errors.conflict('Почта в этой установке не включена')
    const password = mailPassword()
    const address = await MailProvisioning.ensurePerson(ctx, ssha512(password), true)
    return { address, password }
  },

  /** Отзыв пароля для почты: ящик продолжает принимать письма, войти в него нельзя. */
  async revokePassword(ctx: UserCtx): Promise<void> {
    if (!MailProvisioning.enabled()) throw errors.conflict('Почта в этой установке не включена')
    await MailProvisioning.ensurePerson(ctx, ssha512(mailPassword()), false)
  },

  async ensurePerson(ctx: UserCtx, hash: string, set: boolean): Promise<string> {
    const login = (await UserService.profile(ctx.userId))?.login
    if (!login) throw errors.notFound('Сотрудник')
    const address = personAddress(login)
    if (address === registryAddress()) {
      throw errors.conflict('Логин совпадает с ящиком канцелярии — ящик сотруднику не заводится')
    }
    await db().transaction(async (tx) => {
      await tx
        .insert(mailMailboxes)
        .values({
          id: newId(),
          kind: 'person',
          userId: ctx.userId,
          address,
          passwordHash: hash,
          passwordSet: set ? new Date().toISOString() : null,
        })
        .onConflictDoUpdate({
          target: mailMailboxes.userId,
          set: { passwordHash: hash, passwordSet: set ? new Date().toISOString() : null },
        })
      await publishEvent(tx, ctx, {
        type: 'mail.password_changed',
        payload: { userId: ctx.userId, address, set },
      })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.mailPasswordChanged,
          objectId: ctx.userId,
          objectType: 'user',
          details: { address, set },
        },
        tx,
      )
    })
    return address
  },

  /** Ящик канцелярии: заводится при первой синхронизации, пароль знает только платформа. */
  async registry(): Promise<{ address: string; password: string }> {
    const address = registryAddress()
    const [row] = await db()
      .select({ secretEnc: mailMailboxes.secretEnc })
      .from(mailMailboxes)
      .where(and(eq(mailMailboxes.kind, 'registry'), eq(mailMailboxes.address, address)))
      .limit(1)
    if (row?.secretEnc) return { address, password: decryptSecret(row.secretEnc) }
    const password = mailPassword()
    const ctx: Ctx = systemCtx('mail')
    await db().transaction(async (tx) => {
      await tx
        .insert(mailMailboxes)
        .values({
          id: newId(),
          kind: 'registry',
          address,
          passwordHash: ssha512(password),
          passwordSet: new Date().toISOString(),
          secretEnc: encryptSecret(password),
        })
        .onConflictDoNothing()
      await publishEvent(tx, ctx, {
        type: 'mail.mailboxes_synced',
        payload: { created: 1, accounts: 1 },
      })
    })
    return MailProvisioning.registry()
  },

  /**
   * Синхронизация с почтовым сервером: у действующих сотрудников без ящика он заводится со
   * случайным паролем (почта принимается, войти — после пароля в профиле), файл учёток
   * переписывается целиком.
   */
  async sync(): Promise<{ accounts: number; created: number; file: string | null }> {
    if (!MailProvisioning.enabled()) return { accounts: 0, created: 0, file: null }
    const registry = await MailProvisioning.registry()
    const people = (await activePeople()).filter(
      (person) => personAddress(person.login) !== registry.address,
    )
    const existing = new Map(
      (
        await db()
          .select({ userId: mailMailboxes.userId, address: mailMailboxes.address })
          .from(mailMailboxes)
          .where(isNotNull(mailMailboxes.userId))
      ).map((row) => [row.userId as string, row.address]),
    )
    const missing = people.filter((person) => !existing.has(person.id))
    if (missing.length > 0) {
      await db().transaction(async (tx) => {
        await tx
          .insert(mailMailboxes)
          .values(
            missing.map((person) => ({
              id: newId(),
              kind: 'person',
              userId: person.id,
              address: personAddress(person.login),
              passwordHash: ssha512(mailPassword()),
            })),
          )
          .onConflictDoNothing()
        await publishEvent(tx, systemCtx('mail'), {
          type: 'mail.mailboxes_synced',
          payload: { created: missing.length, accounts: people.length + 1 },
        })
      })
    }
    const rows =
      people.length > 0
        ? await db()
            .select({ address: mailMailboxes.address, hash: mailMailboxes.passwordHash })
            .from(mailMailboxes)
            .where(
              inArray(
                mailMailboxes.userId,
                people.map((person) => person.id),
              ),
            )
        : []
    const [registryRow] = await db()
      .select({ hash: mailMailboxes.passwordHash })
      .from(mailMailboxes)
      .where(eq(mailMailboxes.address, registry.address))
      .limit(1)
    const lines = [
      `${registry.address}|${registryRow?.hash ?? ssha512(registry.password)}`,
      ...rows.map((row) => `${row.address}|${row.hash}`).sort(),
    ]
    const file = await writeAccounts(lines)
    logger().info(
      { accounts: lines.length, created: missing.length },
      'почтовые ящики синхронизированы',
    )
    return { accounts: lines.length, created: missing.length, file }
  },

  /**
   * Отправитель исходящих документов — ящик канцелярии своего почтового сервера. `null` —
   * почта установки не включена: исходящие уходят через SMTP_URL.
   */
  async registrySender(): Promise<{ from: string; url: string } | null> {
    const submission = config().MAIL_SUBMISSION_URL.trim()
    if (!MailProvisioning.enabled() || !submission) return null
    const { address, password } = await MailProvisioning.registry()
    const url = new URL(submission)
    url.username = address
    url.password = password
    if (!config().MAIL_TLS_VERIFY) url.searchParams.set('tls.rejectUnauthorized', 'false')
    return { from: address, url: url.toString() }
  },
}
