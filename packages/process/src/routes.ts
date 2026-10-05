import {
  DocumentRouteOptions,
  DocumentRouteStartInput,
  DocumentRouteStepVersions,
  DocumentSignatureList,
  defineRoutes,
} from '@kchs/contracts'
import { z } from 'zod'
import {
  ProcessActInput,
  ProcessAssigneeInput,
  ProcessCancelInput,
  ProcessCatalog,
  ProcessDefinitionDetails,
  ProcessDefinitionSummary,
  ProcessDefinitionVersion,
  ProcessDraftInput,
  ProcessDraftSaved,
  ProcessInstanceSummary,
  ProcessInstanceView,
  ProcessPreview,
  ProcessPreviewInput,
  ProcessReassignInput,
  ProcessStartInput,
  ProcessValidateInput,
  ProcessValidation,
} from './api.js'

const KeyParam = z.object({ key: z.string().min(1).max(64) })

const Ok = z.object({ ok: z.boolean() })

const StepParams = z.object({ id: z.uuid(), stepId: z.uuid() })

const IdParam = z.object({ id: z.uuid() })

/**
 * Движок процессов (ADR-0079, ADR-0188). Регистрация — `apps/api/src/kernel/process/`:
 * http.ts.
 */
export const processRoutes = defineRoutes({
  'GET /process-definitions': {
    response: { 200: z.object({ items: z.array(ProcessDefinitionSummary) }) },
  },
  'GET /process-catalog': { response: { 200: ProcessCatalog } },
  'POST /process-definitions': { body: ProcessDraftInput, response: { 200: ProcessDraftSaved } },
  'POST /process-definitions/validate': {
    body: ProcessValidateInput,
    response: { 200: ProcessValidation },
  },
  'POST /process-definitions/preview': {
    body: ProcessPreviewInput,
    response: { 200: ProcessPreview },
  },
  'GET /process-definitions/:key': {
    params: KeyParam,
    response: { 200: ProcessDefinitionDetails },
  },
  'GET /process-definitions/:key/versions/:version': {
    params: KeyParam.extend({ version: z.coerce.number().int().min(1) }),
    response: { 200: ProcessDefinitionVersion },
  },
  'PUT /process-definitions/:key/draft': {
    params: KeyParam,
    body: ProcessDraftInput,
    response: { 200: ProcessDraftSaved },
  },
  'DELETE /process-definitions/:key/draft': { params: KeyParam, response: { 200: Ok } },
  'POST /process-definitions/:key/publish': {
    params: KeyParam,
    response: { 200: ProcessDefinitionVersion },
  },
  'POST /processes': { body: ProcessStartInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /processes': {
    query: z.object({ objectId: z.uuid() }),
    response: { 200: z.object({ items: z.array(ProcessInstanceSummary) }) },
  },
  'GET /processes/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: ProcessInstanceView },
  },
  'POST /processes/:id/cancel': {
    params: z.object({ id: z.uuid() }),
    body: ProcessCancelInput,
    response: { 200: Ok },
  },
  'POST /processes/:id/steps/:stepId/act': {
    params: StepParams,
    body: ProcessActInput,
    response: { 200: Ok },
  },
  'POST /processes/:id/steps/:stepId/assignees': {
    params: StepParams,
    body: ProcessAssigneeInput,
    response: { 200: Ok },
  },
  'POST /processes/:id/steps/:stepId/delegate': {
    params: StepParams,
    body: ProcessAssigneeInput,
    response: { 200: Ok },
  },
  'POST /processes/:id/steps/:stepId/reassign': {
    params: StepParams,
    body: ProcessReassignInput,
    response: { 200: Ok },
  },
})

/**
 * Маршруты документа по движку процессов (ADR-0079, ADR-0188). Регистрация —
 * `apps/api/src/modules/documents/http/`: process-routes.ts.
 */
export const documentProcessRoutes = defineRoutes({
  'GET /documents/:id/routes': { params: IdParam, response: { 200: DocumentRouteOptions } },
  'POST /documents/:id/routes/preview': {
    params: IdParam,
    body: DocumentRouteStartInput,
    response: { 200: ProcessPreview },
  },
  'POST /documents/:id/routes': {
    params: IdParam,
    body: DocumentRouteStartInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /documents/:id/route-versions': {
    params: IdParam,
    response: { 200: DocumentRouteStepVersions },
  },
  'GET /documents/:id/signatures': { params: IdParam, response: { 200: DocumentSignatureList } },
})
