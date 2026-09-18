import type { PrincipalRef } from '@kchs/contracts'
import { Avatar, Button, cn, Field, Textarea, useDebouncedValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { principalsQuery } from '~/shared/api/queries.js'
import { type ComposedMessage, composeMessage, type Mention, mentionQuery } from './mention-doc.js'

export type { ComposedMessage }

/**
 * Поле сообщения с упоминаниями (P0-E08 S01): «@» и начало имени открывают
 * список сотрудников; ↑/↓ — выбор, Enter или Tab — вставить, Esc — закрыть.
 * Отправка — кнопкой или ⌘/Ctrl+Enter.
 */
export function MessageComposer({
  onSend,
  pending,
  placeholder,
}: {
  /** Отправка; поле очищается, когда промис выполнен. */
  onSend: (message: ComposedMessage) => Promise<unknown>
  pending?: boolean
  placeholder: string
}) {
  const t = useT()
  const listId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
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

  const send = () => {
    const message = composeMessage(draft, mentions)
    if (!message || pending) return
    const sent = draft
    // Поле очищается, когда сервер принял сообщение: при ошибке текст остаётся.
    // Если за это время начали писать следующее — его не трогаем
    setError(null)
    onSend(message).then(
      () => {
        setDraft((current) => (current === sent ? '' : current))
        setMentions((current) => (draftRef.current === sent ? [] : current))
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
            setError(null)
            detect(event.target.value, event.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTrigger(null)}
          placeholder={placeholder}
          className="min-h-[60px] text-sm"
        />
      </Field>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-2xs text-fg-muted">{t('discussion.sendHintMention')}</span>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!draft.trim()}
          loading={pending}
          icon={<Send className="size-3.5" />}
        >
          {t('discussion.send')}
        </Button>
      </div>
    </form>
  )
}
