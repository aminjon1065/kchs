import type { FileRecord, OfficeEditing, OfficeSession, OfficeStatus } from '@kchs/contracts'
import { officeFormat } from '@kchs/contracts'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'

/**
 * Совместное редактирование офисных файлов (09-files.md §7, ADR-0112).
 * Кнопка «Открыть в редакторе» показывается, только если редактор настроен в
 * установке и формат файла он открывает; недоступный сервер документов —
 * понятное сообщение и обычная загрузка файла, а не пустая вкладка.
 */

export const officeKeys = {
  status: ['files', 'office', 'status'] as const,
  editing: (ids: readonly string[]) => ['files', 'office', 'editing', ...ids] as const,
}

export function officeStatusQuery() {
  return queryOptions({
    queryKey: officeKeys.status,
    queryFn: () => http.get<OfficeStatus>('/files/office/status'),
    // Состояние службы меняется редко: лишний опрос при каждом открытии карточки не нужен
    staleTime: 5 * 60_000,
  })
}

/** Открывает сессию редактирования: адрес страницы редактора и режим. */
export function openOfficeSession(fileId: string): Promise<OfficeSession> {
  return http.post<OfficeSession>(`/files/${fileId}/office-session`)
}

/** Формат файла редактор открывает (DOCX, XLSX, PPTX и родственные). */
export function officeEditable(file: Pick<FileRecord, 'name'> | { name: string }): boolean {
  return officeFormat(file.name) !== null
}

/**
 * Настроен ли редактор в установке. Недоступность самого сервера документов
 * выясняется при открытии — там же и понятное сообщение.
 */
export function useOfficeConfigured(): boolean {
  const { data } = useQuery(officeStatusQuery())
  return Boolean(data?.configured)
}

/** Показывать ли «Открыть в редакторе» для файла с таким именем. */
export function useOfficeAvailable(name: string | undefined): boolean {
  const configured = useOfficeConfigured()
  return configured && name !== undefined && officeFormat(name) !== null
}

/** Открывает редактор вкладкой рабочей области, а не отдельным окном. */
export function useOpenOfficeEditor(): (file: { id: string; name: string }) => void {
  const openTab = useWorkspace((s) => s.openTab)
  return (file) => {
    openTab({
      kind: 'screen',
      screen: 'office-editor',
      title: file.name,
      icon: 'file',
      params: { id: file.id },
      mode: 'permanent',
    })
  }
}

/**
 * Кто сейчас правит файлы в редакторе (N70): карточки показывают «файл правят», а
 * форма новой версии предупреждает. Состояние меняется, пока карточка открыта, —
 * опрос раз в полминуты; без настроенного редактора запроса нет.
 */
export function useOfficeEditing(ids: readonly string[]): Map<string, OfficeEditing> {
  const configured = useOfficeConfigured()
  const sorted = [...new Set(ids)].sort()
  const { data } = useQuery({
    queryKey: officeKeys.editing(sorted),
    queryFn: async () =>
      (await http.get<{ items: OfficeEditing[] }>(`/files/office/editing?ids=${sorted.join(',')}`))
        .items,
    enabled: configured && sorted.length > 0,
    refetchInterval: 30_000,
  })
  return new Map((data ?? []).map((item) => [item.fileId, item]))
}

/** Имена тех, кто в редакторе, — для подсказок и предупреждений. */
export function editorNames(editing: OfficeEditing): string {
  return editing.editors.map((user) => user.displayName).join(', ')
}
