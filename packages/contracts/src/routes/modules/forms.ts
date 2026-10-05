import { z } from 'zod'
import {
  FormControl,
  FormControlQuery,
  FormCreateInput,
  FormDutyList,
  FormEnabledInput,
  FormList,
  FormListQuery,
  FormRecord,
  FormReviewInput,
  FormSchema,
  FormSubmission,
  FormSubmissionOpenInput,
  FormSubmissionSaveInput,
  FormUpdateInput,
} from '../../forms/form.js'
import { defineRoutes } from '../../http/route-contract.js'

const IdParam = z.object({ id: z.uuid() })

const SubmissionParam = z.object({ sid: z.uuid() })

/**
 * Маршруты модуля «forms» (ADR-0188). Регистрация — `apps/api/src/modules/forms/`: http.ts.
 */
export const formsRoutes = defineRoutes({
  'GET /forms': { query: FormListQuery, response: { 200: FormList } },
  'GET /forms/duties': { response: { 200: FormDutyList } },
  'POST /forms': { body: FormCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /forms/:id': { params: IdParam, response: { 200: FormRecord } },
  'PUT /forms/:id': { params: IdParam, body: FormUpdateInput, response: { 200: FormRecord } },
  'POST /forms/:id/enabled': {
    params: IdParam,
    body: FormEnabledInput,
    response: { 200: FormRecord },
  },
  'GET /forms/:id/schema': { params: IdParam, response: { 200: FormSchema } },
  'GET /forms/:id/control': {
    params: IdParam,
    query: FormControlQuery,
    response: { 200: FormControl },
  },
  'POST /forms/:id/submissions': {
    params: IdParam,
    body: FormSubmissionOpenInput,
    response: { 200: FormSubmission },
  },
  'GET /forms/submissions/:sid': { params: SubmissionParam, response: { 200: FormSubmission } },
  'PUT /forms/submissions/:sid': {
    params: SubmissionParam,
    body: FormSubmissionSaveInput,
    response: { 200: FormSubmission },
  },
  'POST /forms/submissions/:sid/submit': {
    params: SubmissionParam,
    body: FormSubmissionSaveInput,
    response: { 200: FormSubmission },
  },
  'POST /forms/submissions/:sid/review': {
    params: SubmissionParam,
    body: FormReviewInput,
    response: { 200: FormSubmission },
  },
})
