/**
 * Публичный API модуля «Файлы» для других модулей
 * (01-overview.md §Как модули взаимодействуют).
 */
import { FileService } from './domain/file-service.js'
import { FileProcessing } from './domain/processing.js'

export { type FileSource, fileSource } from './domain/source.js'

/** Файл из объекта, который уже лежит в хранилище (демо-данные сида, ADR-0063). */
export const registerStoredFile: typeof FileService.registerStored = (ctx, input) =>
  FileService.registerStored(ctx, input)

/** Сгенерированный файл, уже лежащий под своим ключом (PDF-представление документа). */
export const registerGeneratedFile: typeof FileService.registerGenerated = (tx, ctx, input) =>
  FileService.registerGenerated(tx, ctx, input)

/**
 * Извлечённый текст текущей версии (текстовый слой или OCR): ИИ документов
 * (ADR-0088) и сравнение версий (ADR-0085).
 */
export const fileText: typeof FileProcessing.text = (fileId, limit) =>
  FileProcessing.text(fileId, limit)

/**
 * Окончательное уничтожение файлов с содержимым в транзакции вызывающего — акт
 * о выделении документов к уничтожению (ADR-0086). Права проверяет вызывающий.
 */
export const destroyFiles: typeof FileService.destroy = (tx, ctx, fileIds) =>
  FileService.destroy(tx, ctx, fileIds)

/** Имя, тип, размер и ключ хранения файлов — для карточек других модулей. */
export const fileBriefs: typeof FileService.briefs = (fileIds, database) =>
  FileService.briefs(fileIds, database)

export { buckets as fileBuckets, storageKey as fileStorageKey } from '~/kernel/storage/s3.js'

/** Водяной знак файлов с грифом от «конфиденциально» (ADR-0085). */
export { watermarkLevel, watermarkLines } from './domain/watermark.js'
