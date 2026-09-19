/**
 * Публичный API модуля «Файлы» для других модулей
 * (01-overview.md §Как модули взаимодействуют).
 */
import { FileService } from './domain/file-service.js'

export { type FileSource, fileSource } from './domain/source.js'

/** Файл из объекта, который уже лежит в хранилище (демо-данные сида, ADR-0063). */
export const registerStoredFile: typeof FileService.registerStored = (ctx, input) =>
  FileService.registerStored(ctx, input)

/** Сгенерированный файл, уже лежащий под своим ключом (PDF-представление документа). */
export const registerGeneratedFile: typeof FileService.registerGenerated = (tx, ctx, input) =>
  FileService.registerGenerated(tx, ctx, input)

/** Имя, тип, размер и ключ хранения файлов — для карточек других модулей. */
export const fileBriefs: typeof FileService.briefs = (fileIds, database) =>
  FileService.briefs(fileIds, database)

export { buckets as fileBuckets, storageKey as fileStorageKey } from '~/kernel/storage/s3.js'
