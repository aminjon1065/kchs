import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  OFFICE_CONFIDENTIAL,
  OFFICE_UNAVAILABLE,
  type OfficeSession,
  type OfficeStatus,
} from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { buckets, getObjectStream, putObject, storageKey } from '~/kernel/storage/s3.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import type { OfficeSessionRow } from '~/shared/db/schema/index.js'
import { files, fileVersions, objects, officeSessions } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { FileService } from './file-service.js'
import {
  checkTicket,
  OFFICE_EXTENSIONS,
  officeConfig,
  officeDocumentType,
  officeHealthy,
  officeTicket,
  verifyJwt,
} from './office.js'
import { watermarkLevel } from './watermark.js'

/** Сколько живёт сессия редактирования и её пропуска. */
const SESSION_TTL_MS = 12 * 3_600_000
/** Сколько ждём, пока сервер документов отдаст сохранённый файл. */
const SAVE_TIMEOUT_MS = 120_000
const MAX_SAVE_BYTES = 512 * 1024 * 1024

/**
 * Совместное редактирование офисных файлов (09-files.md §7, ADR-0112).
 *
 * Разделение обязанностей:
 *  - права решает `authorize()` на самом файле: `edit` — правка, `view` —
 *    просмотр; сверх этого редактор ничего не добавляет;
 *  - сервер документов получает только то, что ему нужно: адрес содержимого и
 *    адрес колбэка, оба — с подписью и сроком, оба — в `/internal`, куда прокси
 *    снаружи не пускает;
 *  - сохранение возвращается обычной новой версией файла, поэтому событие,
 *    активность, уведомления, превью и текст — те же, что у загрузки.
 */
export const OfficeService = {
  /** Доступность редактора установке: карточка прячет кнопку, пока его нет. */
  async status(): Promise<OfficeStatus> {
    const office = officeConfig()
    if (!office) {
      return { configured: false, available: false, message: null, formats: OFFICE_EXTENSIONS }
    }
    const health = await officeHealthy()
    return {
      configured: true,
      available: health.ok,
      message: health.message,
      formats: OFFICE_EXTENSIONS,
    }
  },

  /**
   * Открыть файл в редакторе: права, гриф, живость сервера — и сессия на
   * текущую версию файла. Одна версия — одна сессия: все, кто открыл тот же
   * файл, попадают в один документ сервера и видят правки друг друга.
   */
  async open(ctx: UserCtx, fileId: string): Promise<OfficeSession> {
    const office = officeConfig()
    if (!office) {
      throw new AppError(
        'service_unavailable',
        'Совместное редактирование не настроено в этой установке',
        503,
        { data: { reason: OFFICE_UNAVAILABLE } },
      )
    }
    await authorize(ctx, 'view', fileId)
    const file = await FileService.get(fileId)
    if (!file) throw errors.notFound('Файл')

    const documentType = officeDocumentType(file.name)
    if (!documentType) {
      throw errors.validation('Этот формат редактор не открывает', [
        { path: 'fileId', message: 'unsupported_format' },
      ])
    }

    // Гриф от «конфиденциально»: исходник наружу не уходит — ни скачиванием,
    // ни в чужой редактор (08-documents.md §13, ADR-0085)
    const level = await watermarkLevel(fileId)
    if (level) {
      throw new AppError('forbidden', 'Файл с грифом не открывается во внешнем редакторе', 403, {
        data: { reason: OFFICE_CONFIDENTIAL, confidentiality: level },
      })
    }

    const health = await officeHealthy()
    if (!health.ok) {
      throw new AppError('service_unavailable', 'Сервер документов недоступен', 503, {
        data: { reason: OFFICE_UNAVAILABLE, detail: health.message },
      })
    }

    const canEdit = (await authorize(ctx, 'edit', fileId, { soft: true })).allowed
    // Файл, занятый другим человеком, открывается только на просмотр
    const lockedByOther = file.lockedBy !== null && file.lockedBy.id !== ctx.userId
    const mode = canEdit && !lockedByOther ? 'edit' : 'view'

    const session = await ensureSession(ctx, {
      fileId,
      versionId: file.currentVersionId,
      spaceId: file.spaceId,
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.officeOpened,
      objectId: fileId,
      objectType: 'file',
      details: { sessionId: session.id, mode },
    })

    return {
      id: session.id,
      fileId,
      versionId: session.versionId,
      name: file.name,
      mode,
      documentType,
      editorUrl: `/api/v1/office/editor/${session.id}`,
      expiresAt: session.expiresAt,
    }
  },

  /** Сессия по идентификатору — для страницы редактора и колбэков. */
  async session(sessionId: string): Promise<OfficeSessionRow | null> {
    const [row] = await db()
      .select()
      .from(officeSessions)
      .where(eq(officeSessions.id, sessionId))
      .limit(1)
    return row ?? null
  },

  /**
   * Содержимое версии серверу документов. Пропуск подписан секретом установки
   * и живёт столько же, сколько сессия; сам маршрут — служебный.
   */
  async content(
    sessionId: string,
    ticket: string,
  ): Promise<{ body: Readable; mime: string; size: number | null; name: string }> {
    const office = officeConfig()
    if (!office) throw errors.notFound()
    if (!checkTicket(ticket, sessionId, 'content', office.secret)) throw errors.notFound()
    const session = await OfficeService.session(sessionId)
    if (!session) throw errors.notFound('Сессия редактирования')

    const [row] = await db()
      .select({ name: files.name, mime: files.mime, storageKey: files.storageKey })
      .from(files)
      .where(eq(files.id, session.fileId))
      .limit(1)
    if (!row) throw errors.notFound('Файл')

    // Читается ровно та версия, на которой открыт редактор
    let key = row.storageKey
    if (session.versionId) {
      const [version] = await db()
        .select({ storageKey: fileVersions.storageKey })
        .from(fileVersions)
        .where(eq(fileVersions.id, session.versionId))
        .limit(1)
      if (version) key = version.storageKey
    }

    const stored = await getObjectStream(key)
    return {
      body: stored.body,
      mime: stored.contentType ?? row.mime,
      size: stored.contentLength,
      name: row.name,
    }
  },

  /**
   * Колбэк сервера документов. Состояния протокола редактора: 1 — документ
   * правят, 2 — правка готова к сохранению, 3 — сервер не смог сохранить,
   * 4 — закрыт без изменений, 6/7 — принудительное сохранение и его ошибка.
   * При успехе ответ всегда `{"error": 0}`: иначе сервер документов повторяет
   * колбэк и держит документ «не сохранённым».
   */
  async callback(
    sessionId: string,
    ticket: string,
    body: Record<string, unknown>,
    authorization: string | undefined,
  ): Promise<{ error: number }> {
    const office = officeConfig()
    if (!office) throw errors.notFound()
    if (!checkTicket(ticket, sessionId, 'callback', office.secret)) throw errors.notFound()

    // Подпись колбэка: сервер документов кладёт тело в JWT заголовка
    const token = /^Bearer\s+(\S+)$/i.exec((authorization ?? '').trim())?.[1]
    const claims = token ? verifyJwt(token, office.secret) : null
    if (!claims) throw errors.unauthorized('Колбэк редактора без действительной подписи')
    const signed = (
      typeof claims.payload === 'object' && claims.payload !== null ? claims.payload : claims
    ) as Record<string, unknown>

    const session = await OfficeService.session(sessionId)
    if (!session) throw errors.notFound('Сессия редактирования')

    const status = Number(signed.status ?? body.status ?? 0)
    const url = typeof signed.url === 'string' ? signed.url : null

    if (status === 1) {
      await touch(sessionId, { status: 'open' })
      return { error: 0 }
    }
    if (status === 4) {
      await touch(sessionId, { status: 'closed' })
      return { error: 0 }
    }
    if (status === 3 || status === 7) {
      const message = typeof signed.error === 'string' ? signed.error : 'Ошибка сервера документов'
      await touch(sessionId, { status: 'failed', error: message })
      logger().warn({ sessionId, error: message }, 'редактор не сохранил документ')
      return { error: 0 }
    }
    if (status !== 2 && status !== 6) {
      await touch(sessionId, {})
      return { error: 0 }
    }
    if (!url) {
      await touch(sessionId, { status: 'failed', error: 'Сервер документов не прислал файл' })
      return { error: 0 }
    }

    await saveFromEditor(session, url, Array.isArray(signed.users) ? signed.users.length : 1)
    return { error: 0 }
  },

  /**
   * Обслуживание: сессии, о которых сервер документов больше не сообщает
   * (вкладку закрыли вместе с браузером, сервер перезапустили), закрываются по
   * сроку — иначе «файл редактируется» не кончится никогда.
   */
  async closeStale(): Promise<number> {
    const rows = await db()
      .update(officeSessions)
      .set({ status: 'closed', updatedAt: sql`now()` })
      .where(
        and(
          sql`${officeSessions.status} in ('open', 'saving')`,
          sql`${officeSessions.expiresAt} < now()`,
        ),
      )
      .returning({ id: officeSessions.id })
    return rows.length
  },
}

async function touch(
  sessionId: string,
  patch: { status?: string; error?: string | null },
): Promise<void> {
  await db()
    .update(officeSessions)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      lastCallbackAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(officeSessions.id, sessionId))
}

/**
 * Ключ документа сервера редактора считается от файла и его версии: новая
 * версия — новый ключ, и сервер забирает содержимое заново. С постоянным
 * ключом редактор после сохранения продолжал бы показывать свою копию.
 */
function documentKey(fileId: string, versionId: string | null): string {
  return createHash('sha256')
    .update(`${fileId}:${versionId ?? 'v0'}`)
    .digest('hex')
    .slice(0, 40)
}

async function ensureSession(
  ctx: UserCtx,
  input: { fileId: string; versionId: string | null; spaceId: string },
): Promise<OfficeSessionRow> {
  const key = documentKey(input.fileId, input.versionId)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const [row] = await db()
    .insert(officeSessions)
    .values({
      id: newId(),
      fileId: input.fileId,
      versionId: input.versionId,
      docKey: key,
      spaceId: input.spaceId,
      openedBy: ctx.userId,
      status: 'open',
      expiresAt,
    })
    .onConflictDoUpdate({
      target: officeSessions.docKey,
      // Тот же файл и та же версия — та же сессия: второй редактор входит в
      // неё, а не заводит вторую; срок продлевается, пока документ открыт
      set: { status: 'open', expiresAt, error: null, updatedAt: sql`now()` },
    })
    .returning()
  if (!row) throw errors.internal('Сессия редактирования не создана')
  return row
}

/** Адреса содержимого и колбэка для сервера документов — с подписью и сроком. */
export function officeUrls(sessionId: string): { content: string; callback: string } {
  const office = officeConfig()
  if (!office) throw errors.internal('Сервер документов не настроен')
  const content = officeTicket(sessionId, 'content', office.secret, SESSION_TTL_MS)
  const callback = officeTicket(sessionId, 'callback', office.secret, SESSION_TTL_MS)
  return {
    content: `${office.callbackUrl}/api/v1/internal/office/${sessionId}/content?t=${content}`,
    callback: `${office.callbackUrl}/api/v1/internal/office/${sessionId}/callback?t=${callback}`,
  }
}

/**
 * Правка из редактора становится обычной новой версией файла. Инициатор —
 * тот, кто открыл сессию: сервер документов прав не имеет, а редактор ему
 * открыл человек, которому `authorize(edit)` это разрешил.
 */
async function saveFromEditor(
  session: OfficeSessionRow,
  url: string,
  editors: number,
): Promise<void> {
  await touch(session.id, { status: 'saving' })
  const ctx: Ctx = systemCtx('files.office', { initiatorId: session.openedBy })

  const [file] = await db()
    .select({
      id: files.id,
      name: files.name,
      mime: files.mime,
      currentVersionId: files.currentVersionId,
      versionNumber: files.versionNumber,
      spaceId: objects.spaceId,
    })
    .from(files)
    .innerJoin(objects, eq(objects.id, files.id))
    .where(eq(files.id, session.fileId))
    .limit(1)
  if (!file?.spaceId) {
    await touch(session.id, { status: 'failed', error: 'Файл не найден' })
    return
  }

  let body: Buffer
  try {
    body = await download(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'не скачалась'
    await touch(session.id, { status: 'failed', error: `Правка не сохранена: ${message}` })
    logger().error({ sessionId: session.id, error: message }, 'правка редактора не скачалась')
    return
  }

  const versionId = newId()
  const key = storageKey(file.spaceId, file.id, versionId, file.name)
  await putObject(key, body, { bucket: buckets.files(), contentType: file.mime })

  // Конфликт: пока редактор был открыт, у файла появилась другая версия.
  // Ничего не теряется — правка ложится следующей версией, но об этом сказано
  // в примечании к ней и видно в сессии (ADR-0112)
  const conflict = file.currentVersionId !== session.versionId
  const note = conflict
    ? `Совместное редактирование: сохранено поверх версии ${file.versionNumber}`
    : editors > 1
      ? `Совместное редактирование (${editors})`
      : 'Совместное редактирование'

  await db().transaction(async (tx) => {
    await FileService.addStoredVersion(tx, ctx, {
      fileId: file.id,
      versionId,
      spaceId: file.spaceId,
      storageKey: key,
      size: body.byteLength,
      mime: file.mime,
      note,
    })
    await tx
      .update(officeSessions)
      .set({
        status: 'saved',
        savedVersionId: versionId,
        conflict,
        error: null,
        lastCallbackAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(officeSessions.id, session.id))
  })
}

/** Скачивание правки у сервера документов: свой контур, но с потолком и сроком. */
async function download(url: string): Promise<Buffer> {
  const office = officeConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS)
  try {
    const response = await fetch(rewriteHost(url, office?.internalUrl ?? null), {
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`ответ ${response.status}`)
    if (Number(response.headers.get('content-length') ?? 0) > MAX_SAVE_BYTES) {
      throw new Error('файл слишком велик')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_SAVE_BYTES) throw new Error('файл слишком велик')
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Адрес, который прислал сервер документов, указывает на него самого — иногда
 * именем его контейнера, из нашей сети недостижимым. Берём известное нам
 * происхождение сервера, путь и параметры оставляем как есть.
 */
function rewriteHost(url: string, internal: string | null): string {
  if (!internal) return url
  try {
    const parsed = new URL(url)
    const base = new URL(internal)
    if (parsed.origin === base.origin) return url
    parsed.protocol = base.protocol
    parsed.host = base.host
    return parsed.toString()
  } catch {
    return url
  }
}
