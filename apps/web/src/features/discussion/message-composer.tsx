import type { PrincipalRef } from '@kchs/contracts'
import { formatFileSize } from '@kchs/fields'
import {
  Avatar,
  Button,
  cn,
  Field,
  IconButton,
  Spinner,
  Textarea,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Paperclip, Send, X } from 'lucide-react'
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { principalsQuery } from '~/shared/api/queries.js'
import { type ComposedMessage, composeMessage, type Mention, mentionQuery } from './mention-doc.js'

export type { ComposedMessage }

/** Файл, прикреплённый к набираемому сообщению: пока грузится — без id. */
interface Attached {
  key: string
  id: string | null
  name: string
  size: number
}

/**
 * Поле сообщения с упоминаниями (P0-E08 S01): «@» и начало имени открывают
 * список сотрудников; ↑/↓ — выбор, Enter или Tab — вставить, Esc — закрыть.
 * Отправка — кнопкой или ⌘/Ctrl+Enter. Со скрепкой (`onAttach`) к сообщению
 * прикрепляются файлы — они загружаются сразу, отправляются вместе с текстом.
 */
export function MessageComposer({
  onSend,
  onAttach,
  pending,
  placeholder,
  initialValue,
  onValueChange,
}: {
  /** Отправка; поле очищается, когда промис выполнен. */
  onSend: (message: ComposedMessage) => Promise<unknown>
  /** Загрузка вложения; возвращает созданный файл. */
  onAttach?: (file: File) => Promise<{ id: string; name: string; size: number }>
  pending?: boolean
  placeholder: string
  /** Начальный текст — восстановленный черновик беседы (ADR-0090). */
  initialValue?: string
  /** Изменение текста — чтобы вызывающий сохранил черновик. */
  onValueChange?: (text: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attached, setAttached] = useState<Attached[]>([])
  const uploading = attached.some((item) => item.id === null)
  const listId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(initialValue ?? '')
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Ошибка отправки — под полем, как у формы: всплывающее сообщение
  // закрывало бы кнопку «Отправить» в углу панели
  const [error, setError] = useState<string | null>(null)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [trigger, setTrigger] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  // Позиция курсора после вставки упоминания — ставится сразу после отрисовки,
  // до следующего ввода: отложенная установка теряла набранные вслед символы
  const caretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (caretRef.current === null || !field) return
    field.setSelectionRange(caretRef.current, caretRef.current)
    caretRef.current = null
  })
  const query = useDebouncedValue(trigger?.query ?? '', 150)
  const { data: candidates = [] } = useQuery({
    ...principalsQuery(query, 'user'),
    enabled: Boolean(trigger && query),
  })
  const open = Boolean(trigger) && candidates.length > 0

  const detect = (value: string, caret: number) => {
    setTrigger(mentionQuery(value, caret))
    setActive(0)
  }

  const pick = (candidate: PrincipalRef) => {
    const field = fieldRef.current
    if (!trigger || !field) return
    const label = `@${candidate.title} `
    const next = `${draft.slice(0, trigger.start)}${label}${draft.slice(field.selectionStart)}`
    caretRef.current = trigger.start + label.length
    setDraft(next)
    setMentions((current) =>
      current.some((item) => item.id === candidate.id)
        ? current
        : [...current, { id: candidate.id, name: candidate.title }],
    )
    setTrigger(null)
    field.focus()
  }

  const attach = async (files: FileList | null) => {
    if (!onAttach || !files) return
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`
      setAttached((list) => [...list, { key, id: null, name: file.name, size: file.size }])
      try {
        const created = await onAttach(file)
        setAttached((list) =>
          list.map((item) => (item.key === key ? { ...item, id: created.id } : item)),
        )
      } catch (err) {
        setAttached((list) => list.filter((item) => item.key !== key))
        setError(
          t('discussion.attachFailed', {
            name: file.name,
            reason: err instanceof ApiError ? err.message : t('errors.unknown'),
          }),
        )
      }
    }
  }

  const send = () => {
    const ready = attached.flatMap((item) => (item.id ? [item.id] : []))
    const message = composeMessage(draft, mentions, ready)
    if (!message || pending || uploading) return
    const sent = draft
    // Поле очищается, когда сервер принял сообщение: при ошибке текст остаётся.
    // Если за это время начали писать следующее — его не трогаем
    setError(null)
    onSend(message).then(
      () => {
        setDraft((current) => {
          if (current !== sent) return current
          onValueChange?.('')
          return ''
        })
        setMentions((current) => (draftRef.current === sent ? [] : current))
        // Отправленные вложения уходят из поля; добавленные за это время — остаются
        setAttached((list) => list.filter((item) => !item.id || !ready.includes(item.id)))
        setTrigger(null)
      },
      (err: unknown) =>
        setError(
          t('discussion.notSent', {
            reason: err instanceof ApiError ? err.message : t('errors.unknown'),
          }),
        ),
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => (index + step + candidates.length) % candidates.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const candidate = candidates[active]
        if (candidate) pick(candidate)
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        setTrigger(null)
        return
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form
      className="relative shrink-0 border-t border-line bg-surface p-2"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('discussion.mention')}
          className="absolute inset-x-2 bottom-full z-(--z-dropdown) mb-1 max-h-56 overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-md"
        >
          {candidates.map((candidate, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: вариант выбирается с клавиатуры из поля (aria-activedescendant)
            <div
              key={candidate.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // mousedown не уводит фокус из поля
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(candidate)}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-sm',
                index === active && 'bg-surface-3',
              )}
            >
              <Avatar name={candidate.title} src={candidate.avatarUrl} size="xs" />
              <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
              {candidate.subtitle ? (
                <span className="shrink-0 truncate text-2xs text-fg-muted">
                  {candidate.subtitle}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <Field error={error}>
        <Textarea
          ref={fieldRef}
          value={draft}
          aria-label={placeholder}
          aria-invalid={error ? true : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.target.value)
            onValueChange?.(event.target.value)
            setError(null)
            detect(event.target.value, event.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTrigger(null)}
          placeholder={placeholder}
          className="min-h-[60px] text-sm"
        />
      </Field>
      {attached.length > 0 ? (
        <ul aria-label={t('discussion.attachments')} className="mt-1.5 flex flex-wrap gap-1">
          {attached.map((item) => (
            <li
              key={item.key}
              className="flex max-w-full items-center gap-1.5 rounded-sm border border-line bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs"
            >
              {item.id ? null : <Spinner className="size-3" />}
              <span className="min-w-0 truncate text-fg">{item.name}</span>
              <span className="shrink-0 text-fg-muted">
                {formatFileSize(item.size, { locale })}
              </span>
              <IconButton
                size="sm"
                label={t('discussion.detach', { name: item.name })}
                onClick={() => setAttached((list) => list.filter((row) => row.key !== item.key))}
              >
                <X className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1">
        {onAttach ? (
          <>
            <IconButton
              size="sm"
              label={t('discussion.attach')}
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip className="size-3.5" />
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void attach(event.target.files)
                event.target.value = ''
              }}
            />
          </>
        ) : null}
        <span className="flex-1 text-2xs text-fg-muted">{t('discussion.sendHintMention')}</span>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={(!draft.trim() && !attached.some((item) => item.id)) || uploading}
          loading={pending}
          icon={<Send className="size-3.5" />}
        >
          {t('discussion.send')}
        </Button>
      </div>
    </form>
  )
}
