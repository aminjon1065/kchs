import type {
  FormControlQuery,
  FormCreateInput,
  FormReviewInput,
  FormSubject,
  FormSubmissionSaveInput,
  FormSubmissionSubmitInput,
  FormUpdateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiQuery } from '~/shared/api/route-types.js'
import { localPhoto } from '~/shared/offline/photos.js'
import { cachedFetch, OFFLINE_AWARE } from '~/shared/offline/queue.js'

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
    ...OFFLINE_AWARE,
    queryKey: formKeys.list(query),
    // Список и карточка формы — тоже без сети: экран открывается из кэша устройства (ADR-0207)
    queryFn: () =>
      cachedFetch(`forms.list:${JSON.stringify(query)}`, () => http.get('/forms', { query })),
  })

export const formDutiesQuery = () =>
  queryOptions({
    ...OFFLINE_AWARE,
    queryKey: formKeys.duties(),
    // Назначения нужны и без сети: сводку заполняют там, где связь пропадает (ADR-0204)
    queryFn: () => cachedFetch('forms.duties', () => http.get('/forms/duties')),
  })

export const formQuery = (id: string) =>
  queryOptions({
    ...OFFLINE_AWARE,
    queryKey: formKeys.form(id),
    queryFn: () =>
      cachedFetch(`forms.form:${id}`, () => http.get('/forms/:id', { params: { id } })),
    enabled: id.length > 0,
  })

export const formSchemaQuery = (id: string) =>
  queryOptions({
    ...OFFLINE_AWARE,
    queryKey: formKeys.schema(id),
    queryFn: () =>
      cachedFetch(`forms.schema:${id}`, () => http.get('/forms/:id/schema', { params: { id } })),
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

/**
 * Снимок поля сводки (ADR-0208): ещё не отправленный — с устройства, отправленный —
 * подписанной ссылкой на файл (её даёт право на файл: вложение формы).
 */
export const formPhotoQuery = (value: string, userId: string | null) =>
  queryOptions({
    ...OFFLINE_AWARE,
    queryKey: ['forms', 'photo', value, userId] as const,
    queryFn: async () => {
      const local = userId ? await localPhoto(value, userId) : null
      if (local) return { kind: 'local' as const, blob: local.blob }
      const link = await http.get('/files/:id/download', {
        params: { id: value },
        query: { inline: true },
      })
      return { kind: 'remote' as const, url: link.url }
    },
    // Подписанная ссылка живёт 15 минут
    staleTime: 5 * 60_000,
    retry: false,
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
  /** Сдача с ключом идемпотентности: повтор из очереди не сдаёт второй раз (ADR-0204). */
  submit: (sid: string, input: FormSubmissionSubmitInput) =>
    http.post('/forms/submissions/:sid/submit', { params: { sid }, body: input }),
  review: (sid: string, input: FormReviewInput) =>
    http.post('/forms/submissions/:sid/review', { params: { sid }, body: input }),
}

/** Датасет формы: поля для настройки. */
export const formDatasetQuery = (id: string) =>
  queryOptions({
    queryKey: ['forms', 'dataset', id],
    queryFn: () => http.get('/datasets/:id', { params: { id } }),
  })

/** Датасет новой формы: поля для первого вопроса. */
export const newFormDatasetQuery = (id: string) =>
  queryOptions({
    queryKey: ['forms', 'new-dataset', id],
    queryFn: () => http.get('/datasets/:id', { params: { id } }),
  })
