import { Upload } from 'lucide-react'
import { type DragEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void
  multiple?: boolean
  /** Допустимые типы, как у `<input accept>`. */
  accept?: string
  disabled?: boolean
  /** Одна строка — для панелей и форм; иначе крупная зона для пустых состояний. */
  compact?: boolean
  label?: ReactNode
  hint?: ReactNode
  className?: string
}

/**
 * Зона загрузки файлов (03-ui/02-design-system.md, FileDropzone): перетаскивание
 * или выбор в диалоге. Это `<label>` вокруг скрытого поля файла — с клавиатуры
 * поле получает фокус (кольцо на рамке зоны), Enter или пробел открывают выбор.
 */
export function FileDropzone({
  onFiles,
  multiple = true,
  accept,
  disabled,
  compact,
  label,
  hint,
  className,
}: FileDropzoneProps) {
  const t = useUiT()
  const inputId = useId()
  const [active, setActive] = useState(false)
  // dragenter/dragleave приходят и от вложенных элементов — считаем глубину
  const depth = useRef(0)

  const take = (list: FileList | null) => {
    const files = list ? Array.from(list) : []
    if (files.length === 0 || disabled) return
    onFiles(multiple ? files : files.slice(0, 1))
  }

  const allowDrop = (event: DragEvent) => {
    if (disabled || !event.dataTransfer.types.includes('Files')) return false
    event.preventDefault()
    return true
  }

  return (
    <label
      htmlFor={inputId}
      data-field
      onDragEnter={(event) => {
        if (!allowDrop(event)) return
        depth.current += 1
        setActive(true)
      }}
      onDragOver={(event) => {
        if (allowDrop(event)) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        depth.current = 0
        setActive(false)
        take(event.dataTransfer.files)
      }}
      className={cn(
        'flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-line-strong bg-surface text-fg-secondary',
        'transition-colors duration-[var(--duration-fast)] hover:border-accent hover:text-fg',
        compact ? 'min-h-10 px-3 py-2 text-xs' : 'min-h-28 flex-col px-4 py-6 text-sm',
        active && 'border-accent bg-accent-subtle text-accent',
        disabled &&
          'cursor-not-allowed opacity-50 hover:border-line-strong hover:text-fg-secondary',
        className,
      )}
    >
      <input
        id={inputId}
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          take(event.target.files)
          // Тот же файл можно выбрать повторно
          event.target.value = ''
        }}
      />
      <Upload className={compact ? 'size-4 shrink-0' : 'size-6'} aria-hidden />
      <span className="text-center">{label ?? t('ui.dropzone.label')}</span>
      {hint ? <span className="text-center text-2xs text-fg-muted">{hint}</span> : null}
    </label>
  )
}
