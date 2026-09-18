import {
  FileRecord,
  FileVersion,
  FolderCreateInput,
  FolderRecord,
  type ObjectSummary,
  UploadCompleteInput,
  UploadSessionInput,
} from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { files, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FileService } from './domain/file-service.js'

const IdParam = z.object({ id: z.uuid() })

export function registerFilesObjectTypes(): void {
  registerObjectType({
    type: 'file',
    labelKey: 'objects.types.file',
    icon: 'file',
    route: (id) => `/files/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      download: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      upload_version: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    summary: async (ids) => {
      const rows = await db()
        .select({ id: files.id, mime: files.mime, size: files.size, version: files.versionNumber })
        .from(files)
        .where(inArray(files.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: { mime: row.mime, size: row.size, version: row.version },
          } as Partial<ObjectSummary>,
        ]),
      )
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          id: files.id,
          name: files.name,
          mime: files.mime,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
        })
        .from(files)
        .innerJoin(objects, eq(objects.id, files.id))
        .where(eq(files.id, id))
        .limit(1)
      if (!row) return null
      const text = await FileService.extractedText(id)
      return {
        id,
        objectId: id,
        parentId: row.parentId,
        type: 'file',
        spaceId: row.spaceId,
        title: row.name,
        body: (text ?? '').slice(0, 20_000),
        tags: [],
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { mime: row.mime },
        aclPrincipals: [],
      }
    },
  })
}

export function registerFilesRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/files/upload-sessions',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать сессию загрузки в хранилище',
    schema: {
      body: UploadSessionInput,
      response: {
        200: z.object({
          uploadId: z.uuid(),
          storageKey: z.string(),
          parts: z.array(
            z.object({ partNumber: z.number().int(), url: z.string(), size: z.number().int() }),
          ),
          partSize: z.number().int(),
          expiresAt: z.string(),
          singlePutUrl: z.string().nullable(),
          fileId: z.uuid(),
          versionId: z.uuid(),
        }),
      },
    },
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      // Загрузка в пространство требует права на редактирование пространства или папки
      const target = request.body.folderId ?? request.body.spaceId
      await authorize(
        request.ctx,
        request.body.fileId ? 'upload_version' : 'create_child',
        request.body.fileId ?? target,
      )
      return FileService.createUploadSession(request.ctx, request.body)
    },
  })

  route({
    method: 'POST',
    url: '/files/upload-sessions/:id/complete',
    auth: 'session',
    tags: ['files'],
    summary: 'Завершить загрузку и создать файл',
    schema: { params: IdParam, body: UploadCompleteInput, response: { 200: FileRecord } },
    handler: async (request) =>
      FileService.completeUpload(
        request.ctx,
        request.params.id,
        request.body.parts,
        request.body.note,
      ),
  })

  route({
    method: 'DELETE',
    url: '/files/upload-sessions/:id',
    auth: 'session',
    tags: ['files'],
    summary: 'Отменить загрузку',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await FileService.abortUpload(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/files/:id',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Карточка файла',
    schema: { params: IdParam, response: { 200: FileRecord } },
    handler: async (request) => {
      const file = await FileService.get(request.params.id)
      if (!file) throw errors.notFound('Файл')
      return file
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/versions',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Версии файла',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(FileVersion) }) } },
    handler: async (request) => ({ items: await FileService.versions(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/files/:id/versions/:versionId/restore',
    auth: { action: 'edit' },
    tags: ['files'],
    summary: 'Сделать версию текущей',
    schema: {
      params: z.object({ id: z.uuid(), versionId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        FileService.restoreVersion(tx, request.ctx, request.params.id, request.params.versionId),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/download',
    auth: { action: 'download' },
    tags: ['files'],
    summary: 'Ссылка на скачивание',
    schema: {
      params: IdParam,
      querystring: z.object({
        versionId: z.uuid().optional(),
        inline: z.coerce.boolean().default(false),
      }),
      response: { 200: z.object({ url: z.string(), name: z.string() }) },
    },
    handler: async (request) => {
      const result = await FileService.downloadUrl(
        request.params.id,
        request.query.versionId,
        request.query.inline,
      )
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.fileDownloaded,
        objectId: request.params.id,
        objectType: 'file',
        details: { versionId: request.query.versionId ?? null },
      })
      return result
    },
  })

  route({
    method: 'POST',
    url: '/folders',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать папку',
    schema: { body: FolderCreateInput, response: { 200: FolderRecord } },
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      return db().transaction((tx) => FileService.createFolder(tx, request.ctx, request.body))
    },
  })
}
