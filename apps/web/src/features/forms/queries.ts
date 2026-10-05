import type {
  FormControlQuery,
  FormCreateInput,
  FormReviewInput,
  FormSubject,
  FormSubmissionSaveInput,
  FormUpdateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiQuery } from '~/shared/api/route-types.js'

/** Запросы форм сбора данных (06-analytics-engine.md §13, ADR-0103). */
export const formKeys = {
  all: ['forms'] as const,
  list: (query: ApiQuery<'GET /forms'> = {}) => ['forms', 'list', query] as const,
  duties: () => ['forms', 'duties'] as const,
  form: (id: string) => ['forms', 'form', id] as const,
  schema: (id: string) => ['forms', 'schema', id] as const,
  control: (id: string, periods: number) => ['forms', 'control', id, periods] as const,
  submission: (id: string) => ['forms', 'submission', id] as const,
}

export const formsQuery = (query: ApiQuery<'GET /forms'> = {}) =>
  queryOptions({
    queryKey: formKeys.list(query),
    queryFn: () => http.get('/forms', { query }),
  })

export const formDutiesQuery = () =>
  queryOptions({
    queryKey: formKeys.duties(),
    queryFn: () => http.get('/forms/duties'),
  })

export const formQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.form(id),
    queryFn: () => http.get('/forms/:id', { params: { id } }),
    enabled: id.length > 0,
  })

export const formSchemaQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.schema(id),
    queryFn: () => http.get('/forms/:id/schema', { params: { id } }),
    enabled: id.length > 0,
  })

export const formControlQuery = (id: string, periods: number) =>
  queryOptions({
    queryKey: formKeys.control(id, periods),
    queryFn: () =>
      http.get('/forms/:id/control', {
        params: { id },
        query: { periods } satisfies Partial<FormControlQuery>,
      }),
    enabled: id.length > 0,
  })

export const formSubmissionQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.submission(id),
    queryFn: () => http.get('/forms/submissions/:sid', { params: { sid: id } }),
    enabled: id.length > 0,
  })

export const formsApi = {
  create: (input: FormCreateInput) => http.post('/forms', { body: input }),
  update: (id: string, body: FormUpdateInput) => http.put('/forms/:id', { params: { id }, body }),
  setEnabled: (id: string, enabled: boolean) =>
    http.post('/forms/:id/enabled', { params: { id }, body: { enabled } }),
  open: (id: string, periodKey: string, subject: FormSubject) =>
    http.post('/forms/:id/submissions', { params: { id }, body: { periodKey, subject } }),
  /** Черновик: у одиночной формы — значения, у табличной — строки (ADR-0129). */
  save: (sid: string, input: FormSubmissionSaveInput) =>
    http.put('/forms/submissions/:sid', { params: { sid }, body: input }),
  submit: (sid: string, input: FormSubmissionSaveInput) =>
    http.post('/forms/submissions/:sid/submit', { params: { sid }, body: input }),
  review: (sid: string, input: FormReviewInput) =>
    http.post('/forms/submissions/:sid/review', { params: { sid }, body: input }),
}
