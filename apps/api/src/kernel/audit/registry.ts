import { AUDIT_ACTIONS } from './service.js'

/**
 * Каталог действий аудита (ADR-0182). Ядро держит в `AUDIT_ACTIONS` свои действия
 * и обязательные действия безопасности (17-security.md §6); модуль объявляет свои у
 * себя и регистрирует при старте, как типы объектов, — ядро не знает их по именам.
 * Каталог показывает администратору и SIEM, какие действия бывают и чьи они.
 */
const declared = new Map<string, string>()
let kernelActions: Set<string> | null = null

function kernelOwned(): Set<string> {
  kernelActions ??= new Set<string>(Object.values(AUDIT_ACTIONS))
  return kernelActions
}

export function registerAuditActions(owner: string, actions: Record<string, string>): void {
  for (const action of Object.values(actions)) {
    const taken = kernelOwned().has(action) ? 'kernel' : declared.get(action)
    if (taken && taken !== owner) {
      throw new Error(`Действие аудита «${action}» уже объявлено: ${taken}`)
    }
    declared.set(action, owner)
  }
}

export interface AuditActionEntry {
  action: string
  owner: string
}

export function auditActionCatalog(): AuditActionEntry[] {
  const entries: AuditActionEntry[] = [...kernelOwned()].map((action) => ({
    action,
    owner: 'kernel',
  }))
  for (const [action, owner] of declared) entries.push({ action, owner })
  return entries.sort((a, b) => a.action.localeCompare(b.action))
}
