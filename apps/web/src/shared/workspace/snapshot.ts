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

/**
 * Снимок, ещё не дошедший до сервера при перезагрузке. При уходе со страницы снимок уходит
 * запросом `keepalive`, но новая страница может прочесть состояние раньше, чем сервер его
 * запишет, — и открыть прежние вкладки. Поэтому снимок кладётся и в хранилище вкладки
 * браузера (переживает перезагрузку, другим вкладкам не виден) — с сотрудником: после
 * выхода и входа другим чужие вкладки не восстанавливаются.
 */
const UNSAVED_KEY = 'kchs.workspace.unsaved'

export function rememberUnsavedWorkspace(userId: string, snapshot: WorkspaceSnapshot): void {
  try {
    sessionStorage.setItem(UNSAVED_KEY, JSON.stringify({ userId, snapshot }))
  } catch {
    // Хранилище недоступно (приватный режим, квота) — остаётся запрос keepalive
  }
}

/**
 * Снимок, оставленный этим сотрудником при уходе со страницы. Чтение его не стирает:
 * эффект восстановления может запуститься дважды (строгий режим React) — стирает тот
 * запуск, который снимок применил (`forgetUnsavedWorkspace`).
 */
export function readUnsavedWorkspace(userId: string | null | undefined): WorkspaceSnapshot | null {
  if (!userId) return null
  try {
    const raw = sessionStorage.getItem(UNSAVED_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as { userId?: unknown; snapshot?: unknown }
    return saved.userId === userId ? savedWorkspaceSnapshot(saved.snapshot) : null
  } catch {
    return null
  }
}

export function forgetUnsavedWorkspace(): void {
  try {
    sessionStorage.removeItem(UNSAVED_KEY)
  } catch {
    // Хранилище недоступно — забывать нечего
  }
}
