import type { WorkspaceSnapshot } from '~/shared/workspace/types.js'

/**
 * Снимок, сохранённый на сервере: сервер хранит состояние как прислал клиент и не разбирает
 * (`GET /me/workspace-state`, ADR-0188) — версию и панели проверяет клиент. Чужая версия,
 * пустой снимок или не объект — `null`, восстанавливать нечего.
 */
export function savedWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const snapshot = value as Partial<WorkspaceSnapshot>
  return snapshot.version === 1 && Array.isArray(snapshot.panes) && snapshot.panes.length > 0
    ? (snapshot as WorkspaceSnapshot)
    : null
}
