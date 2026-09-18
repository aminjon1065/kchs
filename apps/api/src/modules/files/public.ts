/**
 * Публичный API модуля «Файлы» для других модулей
 * (01-overview.md §Как модули взаимодействуют).
 */
import { FileService } from './domain/file-service.js'

export { type FileSource, fileSource } from './domain/source.js'

/** Файл из объекта, который уже лежит в хранилище (демо-данные сида, ADR-0063). */
export const registerStoredFile: typeof FileService.registerStored = (ctx, input) =>
  FileService.registerStored(ctx, input)
