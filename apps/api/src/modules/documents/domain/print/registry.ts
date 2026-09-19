import type { Confidentiality, Locale, PrintFormParam, PrintPeriod } from '@kchs/contracts'
import type { Translator } from '@kchs/i18n'
import type { UserCtx } from '~/shared/context.js'
import type { SafeHtml } from './html.js'

/** Объект, для которого печатается форма: документ, журнал (дело — позже). */
export interface PrintSubject {
  id: string
  type: string
  spaceId: string
  title: string
  confidentiality: Confidentiality
}

/**
 * Окружение сборки формы: права, язык и пояс того, кто заказал печать, —
 * пересобраны в момент рендера (движок начал задание), а не в момент заказа.
 */
export interface PrintContext {
  ctx: UserCtx
  t: Translator
  locale: Locale
  timezone: string
  /** Название организации (`brand.name`) — шапки форм и штампы. */
  org: string
  now: Date
}

export interface PrintParams {
  period?: PrintPeriod
}

/** Результат сборки: страница формы или наложение на PDF. */
export type PrintBuild =
  | {
      kind: 'html'
      title: string
      body: SafeHtml
      orientation?: 'portrait' | 'landscape'
      /** Левая часть нижнего колонтитула (справа — «Лист N из M»). */
      footer?: string
      /** Имя файла результата (без пути), `.pdf`. */
      fileName: string
    }
  | {
      kind: 'overlay'
      source: { bucket: string; storageKey: string; name: string; mime: string }
      /** Полная страница наложения — `overlayPage()`. */
      html: string
      pages: 'first' | 'all'
      fileName: string
    }

/**
 * Печатная форма (08-documents.md §5, ADR-0085). Чтобы добавить форму:
 *
 * 1. описать её здесь — ключ, подпись, тип объекта, `build` (данные читаются
 *    с правами `pc.ctx`, разметка — через `html`, экранирование обязательно);
 * 2. `registerPrintForm(форма)` при старте модуля (`registerBuiltinPrintForms`
 *    в `forms/index.ts` или своя регистрация через `DocumentsPrint.register`);
 * 3. документу форма видна, когда её ключ есть в `printForms` типа
 *    (`typeListed: false` — всем документам), журналу — всегда.
 *
 * Результат — PDF, прикреплённый к объекту: доступ и гриф — объекта.
 */
export interface PrintFormDefinition {
  key: string
  /** Ключ словаря подписи формы (`documents.print.forms.<ключ>`). */
  labelKey: string
  subjectType: string
  params?: readonly PrintFormParam[]
  /** Документу — только если ключ в `printForms` типа (по умолчанию да). */
  typeListed?: boolean
  /** Почему форма сейчас недоступна объекту (ключ словаря) или null. */
  unavailable?: (subject: PrintSubject) => Promise<string | null>
  build: (pc: PrintContext, subject: PrintSubject, params: PrintParams) => Promise<PrintBuild>
}

const forms = new Map<string, PrintFormDefinition>()

export function registerPrintForm(form: PrintFormDefinition): void {
  forms.set(form.key, form)
}

export function printForm(key: string): PrintFormDefinition | null {
  return forms.get(key) ?? null
}

export function printFormsFor(subjectType: string): PrintFormDefinition[] {
  return [...forms.values()].filter((form) => form.subjectType === subjectType)
}
