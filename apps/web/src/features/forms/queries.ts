import type {
  FormControl,
  FormControlQuery,
  FormCreateInput,
  FormDefinition,
  FormDutyList,
  FormList,
  FormListQuery,
  FormRecord,
  FormReviewInput,
  FormSchema,
  FormSubject,
  FormSubmission,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Запросы форм сбора данных (06-analytics-engine.md §13, ADR-0103). */
export const formKeys = {
  all: ['forms'] as const,
  list: (query: Partial<FormListQuery> = {}) => ['forms', 'list', query] as const,
  duties: () => ['forms', 'duties'] as const,
  form: (id: string) => ['forms', 'form', id] as const,
  schema: (id: string) => ['forms', 'schema', id] as const,
  control: (id: string, periods: number) => ['forms', 'control', id, periods] as const,
  submission: (id: string) => ['forms', 'submission', id] as const,
}

export const formsQuery = (query: Partial<FormListQuery> = {}) =>
  queryOptions({
    queryKey: formKeys.list(query),
    queryFn: () => http.get<FormList>('/forms', { query }),
  })

export const formDutiesQuery = () =>
  queryOptions({
    queryKey: formKeys.duties(),
    queryFn: () => http.get<FormDutyList>('/forms/duties'),
  })

export const formQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.form(id),
    queryFn: () => http.get<FormRecord>(`/forms/${id}`),
    enabled: id.length > 0,
  })

export const formSchemaQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.schema(id),
    queryFn: () => http.get<FormSchema>(`/forms/${id}/schema`),
    enabled: id.length > 0,
  })

export const formControlQuery = (id: string, periods: number) =>
  queryOptions({
    queryKey: formKeys.control(id, periods),
    queryFn: () =>
      http.get<FormControl>(`/forms/${id}/control`, {
        query: { periods } satisfies Partial<FormControlQuery>,
      }),
    enabled: id.length > 0,
  })

export const formSubmissionQuery = (id: string) =>
  queryOptions({
    queryKey: formKeys.submission(id),
    queryFn: () => http.get<FormSubmission>(`/forms/submissions/${id}`),
    enabled: id.length > 0,
  })

export const formsApi = {
  create: (input: FormCreateInput) => http.post<{ id: string }>('/forms', input),
  update: (id: string, body: { name?: string; definition?: FormDefinition }) =>
    http.put<FormRecord>(`/forms/${id}`, body),
  setEnabled: (id: string, enabled: boolean) =>
    http.post<FormRecord>(`/forms/${id}/enabled`, { enabled }),
  open: (id: string, periodKey: string, subject: FormSubject) =>
    http.post<FormSubmission>(`/forms/${id}/submissions`, { periodKey, subject }),
  save: (sid: string, values: Record<string, unknown>) =>
    http.put<FormSubmission>(`/forms/submissions/${sid}`, { values }),
  submit: (sid: string, values: Record<string, unknown>) =>
    http.post<FormSubmission>(`/forms/submissions/${sid}/submit`, { values }),
  review: (sid: string, input: FormReviewInput) =>
    http.post<FormSubmission>(`/forms/submissions/${sid}/review`, input),
}
