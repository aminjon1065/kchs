import { randomUUID } from 'node:crypto'
import { OfficeEditing, OfficeSession, OfficeStatus } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { files } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { officeConfig, officeDocumentType, signJwt } from '../domain/office.js'
import { officeEditorConfig, renderOfficePage } from '../domain/office-page.js'
import { OfficeService, officeUrls } from '../domain/office-service.js'
import { watermarkLevel } from '../domain/watermark.js'

const IdParam = z.object({ id: z.uuid() })
const Ticket = z.object({ t: z.string().min(8).max(200) })

/**
 * Совместное редактирование офисных файлов (09-files.md §7, ADR-0112).
 *
 * Маршрутов пять: три для рабочей области (доступен ли редактор, кто сейчас правит
 * файлы и открыть сессию) и два служебных — по ним сервер документов забирает содержимое и
 * возвращает правку. Служебные лежат в `/internal`, куда прокси снаружи не
 * пускает, и проверяются подписью, а не сессией.
 */
export function registerOfficeRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/files/office/status',
    auth: 'session',
    tags: ['files'],
    summary: 'Доступен ли офисный редактор в этой установке',
    schema: { response: { 200: OfficeStatus } },
    handler: async () => OfficeService.status(),
  })

  route({
    method: 'GET',
    url: '/files/office/editing',
    auth: 'session',
    tags: ['files'],
    summary: 'Какие из файлов сейчас правят в редакторе и кто (N70)',
    schema: {
      querystring: z.object({
        ids: z
          .string()
          .max(4000)
          .transform((value) => value.split(',').filter(Boolean))
          .pipe(z.array(z.uuid()).max(100)),
      }),
      response: { 200: z.object({ items: z.array(OfficeEditing) }) },
    },
    handler: async (request) => ({
      items: await OfficeService.editing(request.ctx, request.query.ids),
    }),
  })

  route({
    method: 'POST',
    url: '/files/:id/office-session',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Открыть файл в офисном редакторе',
    schema: { params: IdParam, response: { 200: OfficeSession } },
    handler: async (request) => OfficeService.open(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/internal/office/:id/content',
    auth: 'public',
    tags: ['internal'],
    summary: 'Сервер документов забирает содержимое версии',
    schema: { params: IdParam, querystring: Ticket },
    handler: async (request, reply) => {
      const stored = await OfficeService.content(request.params.id, request.query.t)
      reply
        .header('content-type', stored.mime)
        .header('cache-control', 'no-store')
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(stored.name)}`,
        )
      if (stored.size !== null) reply.header('content-length', String(stored.size))
      return reply.send(stored.body)
    },
  })

  route({
    method: 'POST',
    url: '/internal/office/:id/callback',
    auth: 'public',
    tags: ['internal'],
    summary: 'Сервер документов сообщает о состоянии и сохраняет правку',
    schema: {
      params: IdParam,
      querystring: Ticket,
      body: z.record(z.string(), z.unknown()),
      response: { 200: z.object({ error: z.number().int() }) },
    },
    handler: async (request) =>
      OfficeService.callback(
        request.params.id,
        request.query.t,
        request.body,
        request.headers.authorization,
      ),
  })
}

/**
 * Страница редактора: не операция API, а документ для кадра рабочей области.
 * Политика CSP — у этого ответа, а не у всей установки: `script-src` называет
 * одноразовый nonce и сервер документов, `connect-src` — только сервер
 * документов, поэтому его скрипт до API платформы не дотягивается (ADR-0112).
 */
export function registerOfficePages(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/office/editor/:id',
    { schema: { hide: true }, config: { auth: 'session' } },
    async (request, reply) => {
      const office = officeConfig()
      if (!office) throw errors.notFound()
      const session = await OfficeService.session(request.params.id)
      if (!session) throw errors.notFound('Сессия редактирования')

      // Адрес страницы правом не является: права проверяются здесь заново
      await authorize(request.ctx, 'view', session.fileId)
      // И гриф тоже: он мог подняться после открытия сессии (ADR-0112)
      if (await watermarkLevel(session.fileId)) throw errors.notFound('Файл')
      const canEdit = (await authorize(request.ctx, 'edit', session.fileId, { soft: true })).allowed

      const [file] = await db()
        .select({ name: files.name, lockedBy: files.lockedBy })
        .from(files)
        .where(eq(files.id, session.fileId))
        .limit(1)
      if (!file) throw errors.notFound('Файл')
      const documentType = officeDocumentType(file.name)
      if (!documentType) throw errors.notFound('Формат не открывается редактором')

      const lockedByOther = file.lockedBy !== null && file.lockedBy !== request.ctx.userId
      const mode = canEdit && !lockedByOther ? 'edit' : 'view'
      const urls = officeUrls(session.id)
      const t = createTranslator(request.ctx.locale)

      const editor = {
        documentType,
        documentKey: session.docKey,
        fileName: file.name,
        title: file.name,
        contentUrl: urls.content,
        // Без права правки сервер документов не получает адреса сохранения:
        // нечем сохранить — нечего и проверять на нашей стороне
        callbackUrl: mode === 'edit' ? urls.callback : null,
        mode,
        lang: request.ctx.locale === 'tg' ? 'ru' : request.ctx.locale,
        user: { id: request.ctx.userId, name: request.ctx.displayName },
      } as const

      const nonce = randomUUID()
      const origin = office.url
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('x-frame-options', 'SAMEORIGIN')
        .header('content-security-policy', pageCsp(origin, nonce))
      return reply.send(
        renderOfficePage({
          ...editor,
          serverUrl: origin,
          nonce,
          failedText: t('files.office.pageFailed'),
          token: signJwt(officeEditorConfig(editor), office.secret, 3600),
        }),
      )
    },
  )
}

/** Политика страницы редактора: только свой nonce и сервер документов. */
function pageCsp(origin: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${origin}`,
    `style-src 'unsafe-inline' ${origin}`,
    `img-src data: blob: ${origin}`,
    `font-src data: ${origin}`,
    `connect-src ${origin} ${origin.replace(/^http/, 'ws')}`,
    `frame-src blob: ${origin}`,
    `frame-ancestors 'self' ${config().KCHS_BASE_URL}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}
