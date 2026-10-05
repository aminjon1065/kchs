import { z } from 'zod'
import { ENGINE_CALLBACKS } from '../../engine/callbacks.js'
import {
  FilePreviews,
  FileRecord,
  FileText,
  FileVersion,
  FileVersionRestoreInput,
  FolderCreateInput,
  FolderRecord,
  UploadCompleteInput,
  UploadResume,
  UploadSessionInput,
} from '../../files/file.js'
import {
  OfficeEditing,
  OfficeSession,
  OfficeStatus,
  OfficeTicketQuery,
} from '../../files/office.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam } from '../params.js'

/**
 * Маршруты модуля «files» (ADR-0188). Регистрация — `apps/api/src/modules/files/`:
 * http/office-routes.ts, module.ts.
 */
export const filesRoutes = defineRoutes({
  'GET /files/office/status': { response: { 200: OfficeStatus } },
  'GET /files/office/editing': {
    query: z.object({
      ids: z
        .string()
        .max(4000)
        .transform((value) => value.split(',').filter(Boolean))
        .pipe(z.array(z.uuid()).max(100)),
    }),
    response: { 200: z.object({ items: z.array(OfficeEditing) }) },
  },
  'POST /files/:id/office-session': { params: IdParam, response: { 200: OfficeSession } },
  'GET /internal/office/:id/content': { params: IdParam, query: OfficeTicketQuery },
  'POST /internal/office/:id/callback': {
    params: IdParam,
    query: OfficeTicketQuery,
    body: z.record(z.string(), z.unknown()),
    response: { 200: z.object({ error: z.number().int() }) },
  },
  'POST /files/upload-sessions': {
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
  'POST /files/upload-sessions/:id/complete': {
    params: IdParam,
    body: UploadCompleteInput,
    response: { 200: FileRecord },
  },
  'GET /files/upload-sessions/:id': { params: IdParam, response: { 200: UploadResume } },
  'DELETE /files/upload-sessions/:id': {
    params: IdParam,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /files/:id': { params: IdParam, response: { 200: FileRecord } },
  'GET /files/:id/versions': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(FileVersion) }) },
  },
  'POST /files/:id/versions/:versionId/restore': {
    params: z.object({ id: z.uuid(), versionId: z.uuid() }),
    body: FileVersionRestoreInput.optional(),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /files/:id/download': {
    params: IdParam,
    query: z.object({
      versionId: z.uuid().optional(),
      inline: z.coerce.boolean().default(false),
    }),
    response: { 200: z.object({ url: z.string(), name: z.string() }) },
  },
  'GET /files/:id/previews': { params: IdParam, response: { 200: FilePreviews } },
  'GET /files/:id/text': { params: IdParam, response: { 200: FileText } },
  'POST /internal/files/:id/processed': {
    params: IdParam,
    body: ENGINE_CALLBACKS.fileProcessed.body,
    response: { 200: ENGINE_CALLBACKS.fileProcessed.reply },
  },
  'GET /files/attachments-folder': {
    query: z.object({ spaceId: z.uuid() }),
    response: { 200: z.object({ id: z.uuid().nullable() }) },
  },
  'POST /folders': { body: FolderCreateInput, response: { 200: FolderRecord } },
})
