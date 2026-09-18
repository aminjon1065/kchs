import { parseValue } from '@kchs/fields'
import { type KeyboardEvent, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { Popover, PopoverAnchor, PopoverContent } from '../../primitives/overlays.js'
import { HEADER_HEIGHT, type RenderColumn } from './layout.js'
import type { ValueContext } from './values.js'

/** Куда перейти после сохранения правки. */
export type EditorMove = 'down' | 'up' | 'right' | 'left' | null

interface GridEditorProps {
  column: RenderColumn
  /** Текст в поле: значение ячейки или первый набранный символ. */
  initialText: string
  /** Правка по Enter/F2 выделяет текст целиком, начало ввода ставит курсор в конец. */
  selectAll: boolean
  /** Верх ячейки в прокручиваемом содержимом таблицы. */
  top: number
  height: number
  /** Ширина столбца номеров и закреплённых столбцов: незакреплённое поле под них не заходит. */
  leading: number
  scrollRef: RefObject<HTMLDivElement | null>
  ctx: ValueContext
  /** `refocus` — вернуть фокус таблице (не нужно, если фокус ушёл щелчком в другое место). */
  onCommit: (value: unknown, move: EditorMove, refocus: boolean) => void
  /** Отмена; `invalid` — поле потеряло фокус с неразборчивым значением. */
  onCancel: (invalid: boolean, refocus: boolean) => void
}

/**
 * Поле правки поверх ячейки. Значение разбирается по типу поля
 * (`@kchs/fields`); неразборчивое не сохраняется — поле остаётся открытым
 * с подсказкой. Enter/Shift+Enter — сохранить и вниз/вверх, Tab/Shift+Tab —
 * вправо/влево, Esc — отменить.
 *
 * Поле лежит в отдельном слое поверх таблицы, а не внутри `role="grid"`:
 * в сетке допустимы только строки и ячейки, а строка с полем может уйти из
 * окна виртуализации. Слой обрезан по области ячеек и следует за прокруткой.
 */
export function GridEditor(props: GridEditorProps) {
  const { column, top, height, leading, scrollRef } = props
  const layerRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const layer = layerRef.current
    const box = boxRef.current
    if (!scroller || !layer || !box) return
    const sync = () => {
      // Полосы прокрутки остаются доступны мыши
      layer.style.right = `${scroller.offsetWidth - scroller.clientWidth}px`
      layer.style.bottom = `${scroller.offsetHeight - scroller.clientHeight}px`
      box.style.top = `${top - HEADER_HEIGHT - scroller.scrollTop}px`
      box.style.left = `${column.pinned ? column.left : column.left - leading - scroller.scrollLeft}px`
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    return () => scroller.removeEventListener('scroll', sync)
  }, [column.pinned, column.left, leading, top, scrollRef])

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute overflow-hidden"
      style={{ top: HEADER_HEIGHT, left: column.pinned ? 0 : leading, right: 0, bottom: 0 }}
    >
      <div
        ref={boxRef}
        className="pointer-events-auto absolute"
        style={{ width: column.width, minHeight: height }}
      >
        {column.editor === 'select' ? <SelectEditor {...props} /> : <TextEditor {...props} />}
      </div>
    </div>
  )
}

function moveFor(event: KeyboardEvent): EditorMove {
  if (event.key === 'Tab') return event.shiftKey ? 'left' : 'right'
  return event.shiftKey ? 'up' : 'down'
}

function useFocusOnMount(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  selectAll: boolean,
) {
  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus({ preventScroll: true })
    if (selectAll) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
  }, [ref, selectAll])
}

const INPUT =
  'block w-full rounded-xs border-2 bg-surface px-2.5 text-sm text-fg shadow-md outline-none'

function TextEditor({
  column,
  initialText,
  selectAll,
  height,
  ctx,
  onCommit,
  onCancel,
}: GridEditorProps) {
  const t = useUiT()
  const hintId = useId()
  const [text, setText] = useState(initialText)
  const [invalid, setInvalid] = useState(false)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useFocusOnMount(ref, selectAll)
  const multiline = column.column.type === 'long_text' || column.column.type === 'json'

  const commit = (move: EditorMove, refocus: boolean): boolean => {
    if (done.current) return true
    const parsed = parseValue(text, column.column, ctx)
    if (!parsed.ok) {
      setInvalid(true)
      return false
    }
    done.current = true
    onCommit(parsed.value, move, refocus)
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      done.current = true
      onCancel(false, true)
    } else if (event.key === 'Tab' || (event.key === 'Enter' && !(multiline && event.shiftKey))) {
      event.preventDefault()
      commit(moveFor(event), true)
    }
  }

  const placeholder =
    column.column.type === 'date'
      ? t('ui.grid.datePlaceholder')
      : column.column.type === 'datetime'
        ? t('ui.grid.datetimePlaceholder')
        : undefined
  const shared = {
    ref,
    value: text,
    'aria-label': t('ui.grid.edit', { name: column.column.label }),
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? hintId : undefined,
    placeholder,
    onKeyDown,
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value)
      setInvalid(false)
    },
    onBlur: () => {
      if (!commit(null, false)) {
        done.current = true
        onCancel(true, false)
      }
    },
    className: cn(
      INPUT,
      invalid ? 'border-danger' : 'border-accent',
      column.numeric && 'text-right tabular',
    ),
  }

  return (
    <>
      {multiline ? (
        <textarea {...shared} rows={4} className={cn(shared.className, 'resize-none py-1.5')} />
      ) : (
        <input
          {...shared}
          inputMode={column.editor === 'number' ? 'decimal' : undefined}
          style={{ height }}
        />
      )}
      {invalid ? (
        <div
          id={hintId}
          className="mt-1 rounded-xs border border-danger bg-surface px-2 py-1 text-xs text-danger shadow-md"
        >
          {t('ui.grid.invalid', { name: column.column.label })}
        </div>
      ) : null}
    </>
  )
}

function SelectEditor({
  column,
  initialText,
  selectAll,
  height,
  ctx,
  onCommit,
  onCancel,
}: GridEditorProps) {
  const t = useUiT()
  const listId = useId()
  const [text, setText] = useState(initialText)
  const [filtering, setFiltering] = useState(!selectAll)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useFocusOnMount(ref, selectAll)

  const options = column.column.options ?? []
  const labelOf = (option: (typeof options)[number]) =>
    option.label[ctx.locale] ?? option.label.ru ?? option.value
  const needle = filtering ? text.trim().toLowerCase() : ''
  const visible = needle
    ? options.filter(
        (option) =>
          labelOf(option).toLowerCase().includes(needle) || option.value.toLowerCase() === needle,
      )
    : options
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => labelOf(option) === initialText),
    ),
  )
  const current = visible[Math.min(highlight, visible.length - 1)]

  const commit = (move: EditorMove, refocus: boolean) => {
    if (done.current) return
    done.current = true
    // Пустое поле очищает значение; иначе — подсвеченный вариант
    if (!text.trim()) onCommit(null, move, refocus)
    else if (current) onCommit(current.value, move, refocus)
    else {
      const parsed = parseValue(text, column.column, ctx)
      if (parsed.ok) onCommit(parsed.value, move, refocus)
      else onCancel(true, refocus)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        done.current = true
        onCancel(false, true)
        break
      case 'ArrowDown':
        event.preventDefault()
        setHighlight((index) => Math.min(visible.length - 1, index + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setHighlight((index) => Math.max(0, index - 1))
        break
      case 'Enter':
      case 'Tab':
        event.preventDefault()
        commit(moveFor(event), true)
        break
      default:
        break
    }
  }

  const optionId = (index: number) => `${listId}-${index}`
  const highlighted = current ? visible.indexOf(current) : -1

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <input
          ref={ref}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
          aria-label={t('ui.grid.edit', { name: column.column.label })}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setFiltering(true)
            setHighlight(0)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(null, false)}
          className={cn(INPUT, 'border-accent')}
          style={{ height }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={2}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="max-h-60 min-w-(--radix-popover-trigger-width) overflow-auto p-1"
      >
        <div id={listId} role="listbox" aria-label={column.column.label}>
          {visible.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-fg-muted">{t('ui.grid.noOptions')}</div>
          ) : (
            visible.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === highlighted}
                // Щелчок не должен забирать фокус у поля — иначе правка закроется раньше выбора
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (done.current) return
                  done.current = true
                  onCommit(option.value, null, true)
                }}
                className={cn(
                  'cursor-pointer rounded-xs px-2 py-1.5 text-sm',
                  index === highlighted ? 'bg-surface-3 text-fg' : 'text-fg-secondary',
                )}
              >
                {labelOf(option)}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
