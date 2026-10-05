import { z } from 'zod'
import {
  ReportCreateInput,
  ReportFormat,
  ReportFromNotebookInput,
  ReportImage,
  ReportPrintPayload,
  ReportRecord,
  ReportRenderResult,
  ReportRenderStart,
  ReportRunDownload,
  ReportRunInput,
  ReportRunList,
  ReportRunRecord,
  ReportSchedule,
  ReportScheduleInput,
  ReportTemplateFlagInput,
  ReportTemplateList,
  ReportVersionInput,
  ReportVersionList,
} from '../../data/report.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam, Ok } from '../params.js'

const RunParam = z.object({ runId: z.uuid() })

/**
 * Маршруты модуля «reports» (ADR-0188). Регистрация — `apps/api/src/modules/reports/`:
 * library-routes.ts, module.ts.
 */
export const reportsRoutes = defineRoutes({
  'GET /reports/templates': { response: { 200: ReportTemplateList } },
  'POST /reports/:id/template': {
    params: IdParam,
    body: ReportTemplateFlagInput,
    response: { 200: ReportRecord },
  },
  'GET /reports/:id/versions': { params: IdParam, response: { 200: ReportVersionList } },
  'POST /reports/:id/versions': {
    params: IdParam,
    body: ReportVersionInput,
    response: { 200: z.object({ number: z.number().int() }) },
  },
  'POST /reports/:id/versions/:versionId/restore': {
    params: z.object({ id: z.uuid(), versionId: z.uuid() }),
    response: { 200: ReportRecord },
  },
  'GET /reports/:id/images/:fileId': {
    params: z.object({ id: z.uuid(), fileId: z.uuid() }),
    response: { 200: ReportImage },
  },
  'GET /reports/:id/files': {
    params: IdParam,
    query: z.object({ ids: z.string().max(2000) }),
    response: {
      200: z.object({
        items: z.array(
          z.object({ id: z.uuid(), name: z.string(), size: z.number(), mime: z.string() }),
        ),
      }),
    },
  },
  'POST /reports': { body: ReportCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'POST /reports/from-notebook': {
    body: ReportFromNotebookInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /reports/:id': { params: IdParam, response: { 200: ReportRecord } },
  'POST /reports/:id/runs': {
    params: IdParam,
    body: ReportRunInput,
    response: { 200: ReportRunRecord },
  },
  'POST /reports/:id/document': {
    params: IdParam,
    body: z.object({ typeId: z.uuid(), subject: z.string().trim().max(500).optional() }),
    response: { 200: z.object({ documentId: z.uuid() }) },
  },
  'GET /reports/:id/runs': { params: IdParam, response: { 200: ReportRunList } },
  'GET /reports/runs/:runId': { params: RunParam, response: { 200: ReportRunRecord } },
  'GET /reports/runs/:runId/download': {
    params: RunParam,
    query: z.object({ format: ReportFormat.default('pdf') }),
    response: { 200: ReportRunDownload },
  },
  'GET /reports/:id/schedule': {
    params: IdParam,
    response: { 200: z.object({ schedule: ReportSchedule.nullable() }) },
  },
  'PUT /reports/:id/schedule': {
    params: IdParam,
    body: ReportScheduleInput,
    response: { 200: ReportSchedule },
  },
  'DELETE /reports/:id/schedule': { params: IdParam, response: { 200: Ok } },
  'POST /reports/:id/schedule/run': {
    params: IdParam,
    response: { 200: z.object({ runs: z.number().int(), skipped: z.number().int() }) },
  },
  'GET /print/report-runs/:runId': { params: RunParam, response: { 200: ReportPrintPayload } },
  'GET /print/reports/:id': { params: IdParam, response: { 200: ReportPrintPayload } },
  'POST /internal/reports/runs/:runId/start': {
    params: RunParam,
    response: { 200: ReportRenderStart },
  },
  'POST /internal/reports/runs/:runId/rendered': {
    params: RunParam,
    body: ReportRenderResult,
    response: { 200: Ok },
  },
})
