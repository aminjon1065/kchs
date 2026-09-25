import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Совместное редактирование офисных файлов (09-files.md §7, ADR-0112):
 * сервер документов ONLYOFFICE открывает DOCX/XLSX/PPTX и возвращает правку
 * колбэком, а платформа сохраняет её обычной новой версией файла.
 */

/** Что умеет открывать редактор: расширение → вид документа ONLYOFFICE. */
export const OFFICE_FORMATS = {
  docx: 'word',
  doc: 'word',
  odt: 'word',
  rtf: 'word',
  txt: 'word',
  xlsx: 'cell',
  xls: 'cell',
  ods: 'cell',
  csv: 'cell',
  pptx: 'slide',
  ppt: 'slide',
  odp: 'slide',
} as const satisfies Record<string, 'word' | 'cell' | 'slide'>

export type OfficeFormat = keyof typeof OFFICE_FORMATS
export const OfficeDocumentType = z.enum(['word', 'cell', 'slide'])
export type OfficeDocumentType = z.infer<typeof OfficeDocumentType>

/** Расширение файла, если редактор его открывает. */
export function officeFormat(name: string): OfficeFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ext in OFFICE_FORMATS ? (ext as OfficeFormat) : null
}

export const OfficeMode = z.enum(['edit', 'view'])
export type OfficeMode = z.infer<typeof OfficeMode>

/** Доступность редактора установке: кнопка прячется, пока сервер не настроен. */
export const OfficeStatus = z.object({
  /** Сервер документов задан переменными окружения. */
  configured: z.boolean(),
  /** Сервер отвечает на проверку живости. */
  available: z.boolean(),
  message: z.string().nullable(),
  /** Расширения, которые редактор открывает. */
  formats: z.array(z.string()),
})
export type OfficeStatus = z.infer<typeof OfficeStatus>

/**
 * Сессия редактирования: страница редактора открывается по этому адресу во
 * вкладке рабочей области. Сам адрес не даёт доступа — страница снова
 * проверяет права открывающего.
 */
export const OfficeSession = z.object({
  id: Uuid,
  fileId: Uuid,
  /** Версия файла, на которой открыт редактор: по ней виден конфликт. */
  versionId: Uuid.nullable(),
  name: z.string(),
  mode: OfficeMode,
  documentType: OfficeDocumentType,
  /** Страница редактора на этом же происхождении (вставляется кадром). */
  editorUrl: z.string(),
  expiresAt: Timestamp,
})
export type OfficeSession = z.infer<typeof OfficeSession>

/**
 * Почему редактор не открылся (`data.reason` ответа об ошибке): карточка файла
 * показывает понятное сообщение и обычную загрузку вместо белого экрана.
 */
export const OFFICE_UNAVAILABLE = 'office_unavailable'
/** Файл с грифом во внешний редактор не отдаётся (ADR-0085). */
export const OFFICE_CONFIDENTIAL = 'office_confidential'

/**
 * Файл сейчас правят в редакторе (вопрос N70): кто в нём по последнему сообщению
 * сервера документов и с какого момента. Загрузить новую версию можно и сейчас —
 * правка из редактора ляжет следующей версией с отметкой о конфликте (ADR-0112).
 */
export const OfficeEditing = z.object({
  fileId: Uuid,
  editors: z.array(UserRef),
  since: Timestamp,
})
export type OfficeEditing = z.infer<typeof OfficeEditing>
