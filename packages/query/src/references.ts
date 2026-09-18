import type { ReferenceRequest } from './types.js'

/** Устойчивый ключ подстановки: один параметр на запрос и строка ключа кэша. */
export function referenceKey(request: ReferenceRequest): string {
  switch (request.kind) {
    case 'territory_level':
      return `territory_level:${request.key}:${request.level}`
    case 'territory_name':
      return `territory_name:${request.key}`
    case 'lookup_label':
      return `lookup_label:${request.datasetId}:${request.keyField}:${request.labelField}`
  }
}

/**
 * Компиляции нужны справочные подстановки, которых нет в контексте
 * (`CompileContext.references`): вызывающий загружает их с правами пользователя
 * и компилирует запрос заново (ADR-0057).
 */
export class MissingReferencesError extends Error {
  readonly requests: ReferenceRequest[]

  constructor(requests: ReferenceRequest[]) {
    super(`Нужны справочные подстановки: ${requests.map(referenceKey).join(', ')}`)
    this.name = 'MissingReferencesError'
    this.requests = requests
  }
}
