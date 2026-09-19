import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { DocumentFileRef } from './document.js'

/**
 * Рендеры модуля документов (08-documents.md §5, §8, §13; ADR-0085): всё, что по
 * заданию модуля строит движок, — печатные формы и штампы (`print`), заполнение
 * шаблона DOCX (`fill`), разбор шаблона (`inspect`) и копия файла с водяным
 * знаком (`watermark`). Общий жизненный цикл: заказ → задание движка → движок
 * берёт план у api (права проверяются в момент рендера) → результат.
 */
export const DOCUMENT_RENDER_KINDS = ['print', 'fill', 'inspect', 'watermark'] as const
export const DocumentRenderKind = z.enum(DOCUMENT_RENDER_KINDS)
export type DocumentRenderKind = z.infer<typeof DocumentRenderKind>

export const DOCUMENT_RENDER_STATUSES = ['queued', 'running', 'ready', 'failed'] as const
export const DocumentRenderStatus = z.enum(DOCUMENT_RENDER_STATUSES)
export type DocumentRenderStatus = z.infer<typeof DocumentRenderStatus>

/** Параметры формы, которые спрашивает интерфейс: период — у реестров журнала. */
export const PRINT_FORM_PARAMS = ['period'] as const
export const PrintFormParam = z.enum(PRINT_FORM_PARAMS)
export type PrintFormParam = z.infer<typeof PrintFormParam>

/** Самый длинный период реестра: больше — это уже выгрузка, а не бумажный реестр. */
export const PRINT_PERIOD_MAX_DAYS = 366

export const PrintPeriod = z
  .object({ from: DateOnly, to: DateOnly })
  .refine((value) => value.from <= value.to, {
    message: 'Начало периода позже конца',
    path: ['to'],
  })
export type PrintPeriod = z.infer<typeof PrintPeriod>

/** Печатная форма, доступная объекту (документу, журналу…), с причиной недоступности. */
export const PrintFormInfo = z.object({
  key: z.string(),
  labelKey: z.string(),
  /** Тип объекта, для которого печатается форма. */
  subjectType: z.string(),
  params: z.array(PrintFormParam),
  available: z.boolean(),
  /** Ключ словаря: почему форма сейчас недоступна (нет регистрации, строится PDF…). */
  reasonKey: z.string().nullable(),
})
export type PrintFormInfo = z.infer<typeof PrintFormInfo>

export const PrintFormList = z.object({ items: z.array(PrintFormInfo) })
export type PrintFormList = z.infer<typeof PrintFormList>

export const PrintRequestInput = z.object({
  subjectId: Uuid,
  form: z.string().min(1).max(64),
  params: z.object({ period: PrintPeriod.optional() }).default({}),
})
export type PrintRequestInput = z.infer<typeof PrintRequestInput>

/** Копия файла документа с водяным знаком (гриф от «конфиденциально»). */
export const WatermarkRequestInput = z.object({ fileId: Uuid })
export type WatermarkRequestInput = z.infer<typeof WatermarkRequestInput>

export const DocumentRenderRecord = z.object({
  id: Uuid,
  kind: DocumentRenderKind,
  subjectId: Uuid,
  /** Ключ печатной формы; у заполнения — шаблон, у копии — исходный файл. */
  form: z.string().nullable(),
  /** Подпись формы — ключ словаря; у заполнения — название шаблона. */
  labelKey: z.string().nullable(),
  label: z.string().nullable(),
  status: DocumentRenderStatus,
  /** Файл реестра с результатом: печатная форма, заполненный шаблон. */
  file: DocumentFileRef.nullable(),
  pages: z.number().int().nullable(),
  error: z.string().nullable(),
  requestedBy: UserRef.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type DocumentRenderRecord = z.infer<typeof DocumentRenderRecord>

export const DocumentRenderList = z.object({ items: z.array(DocumentRenderRecord) })
export type DocumentRenderList = z.infer<typeof DocumentRenderList>

/** Ссылка на копию с водяным знаком: подписанная, с коротким сроком жизни. */
export const DocumentRenderDownload = z.object({ url: z.string(), name: z.string() })
export type DocumentRenderDownload = z.infer<typeof DocumentRenderDownload>

// ─── Движок (внутренние маршруты, сервисный токен) ──────────────────────────

/** Больше этого движок не штампует, не переводит и не заполняет: воркер занят надолго. */
export const DOCUMENT_RENDER_MAX_SOURCE_BYTES = 256 * 1024 * 1024
/** Шаблон DOCX больше этого не принимается. */
export const DOCUMENT_TEMPLATE_MAX_BYTES = 20 * 1024 * 1024

const StoredObject = z.object({ bucket: z.string(), storageKey: z.string() })

/** Куда движок кладёт результат: ключ и имя выдаёт api заранее. */
export const DocumentRenderTarget = StoredObject.extend({
  fileName: z.string(),
  contentType: z.string(),
})
export type DocumentRenderTarget = z.infer<typeof DocumentRenderTarget>

export const RENDER_ORIENTATIONS = ['portrait', 'landscape'] as const
export const DOCUMENT_RENDER_PLAN_KINDS = ['html', 'overlay', 'docx', 'inspect'] as const
export const RENDER_OVERLAY_PAGES = ['first', 'all'] as const

/**
 * План рендера: `html` — страница печатной формы (Chromium → PDF A4);
 * `overlay` — наложение (штамп, водяной знак) на PDF или на файл, который
 * движок сначала переводит в PDF; `docx` — заполнение шаблона (docxtpl в
 * песочнице Jinja); `inspect` — разбор шаблона: найденные плейсхолдеры.
 */
export const DocumentRenderPlan = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('html'),
    html: z.string(),
    title: z.string(),
    orientation: z.enum(RENDER_ORIENTATIONS),
    /** Нижний колонтитул: слева — текст, справа — «Лист N из M». */
    footer: z.string(),
    labels: z.object({ page: z.string(), of: z.string() }),
  }),
  z.object({
    kind: z.literal('overlay'),
    source: StoredObject.extend({ name: z.string(), mime: z.string() }),
    /** HTML наложения: страница того же размера, фон прозрачный. */
    html: z.string(),
    pages: z.enum(RENDER_OVERLAY_PAGES),
  }),
  z.object({
    kind: z.literal('docx'),
    template: StoredObject,
    context: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('inspect'), template: StoredObject }),
])
export type DocumentRenderPlan = z.infer<typeof DocumentRenderPlan>

export const DocumentRenderStart = z.discriminatedUnion('status', [
  z.object({ status: z.literal('skip'), reason: z.string() }),
  z.object({
    status: z.literal('render'),
    plan: DocumentRenderPlan,
    /** Нет у разбора шаблона: результат — список плейсхолдеров, а не файл. */
    target: DocumentRenderTarget.nullable(),
  }),
])
export type DocumentRenderStart = z.infer<typeof DocumentRenderStart>

export const DocumentRenderResult = z.object({
  status: z.enum(['ready', 'failed']),
  size: z.number().int().min(0).nullable().default(null),
  pages: z.number().int().min(0).nullable().default(null),
  /** Разбор шаблона: пути плейсхолдеров (`doc.subject`, `doc.fields.addressee`). */
  placeholders: z.array(z.string().max(200)).max(500).nullable().default(null),
  error: z.string().max(4000).nullable().default(null),
})
export type DocumentRenderResult = z.infer<typeof DocumentRenderResult>
