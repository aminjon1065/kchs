import type { DocumentFileRef, DocumentVersionRecord } from '@kchs/contracts'
import { Badge, Tooltip } from '@kchs/ui'
import { PenLine } from 'lucide-react'
import { editorNames, officeEditable, useOfficeEditing } from '~/entities/files/office.js'
import { useT } from '~/shared/i18n.js'
import { useDocument } from './document-context.js'

/** Файлы версии, которые открывает редактор: основной и приложения. */
export function editableFiles(
  version: DocumentVersionRecord | null | undefined,
): DocumentFileRef[] {
  if (!version) return []
  return [version.mainFile, ...version.attachments].filter(
    (file): file is DocumentFileRef => file !== null && officeEditable(file),
  )
}

/**
 * «Файл правят» в шапке карточки (N70): файл текущей версии открыт в редакторе —
 * видно с любой вкладки, кто именно, — в подсказке. Отдельно от вкладки «Файлы»: шапку
 * показывает и сводка документа во Входящих, без модуля файлов (ADR-0230).
 */
export function OfficeEditingBadge() {
  const t = useT()
  const { document } = useDocument()
  const files = editableFiles(document.currentVersion)
  const editing = useOfficeEditing(files.map((file) => file.id))
  const first = files.map((file) => editing.get(file.id)).find(Boolean)
  if (!first) return null
  return (
    <Tooltip content={t('files.office.editingNow', { names: editorNames(first) })}>
      <Badge size="sm" tone="warning">
        <PenLine className="size-2.5" aria-hidden />
        {t('files.office.editingFile')}
      </Badge>
    </Tooltip>
  )
}
