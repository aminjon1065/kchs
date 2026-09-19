/**
 * Ленивая часть RichTextEditor: Tiptap 3 (ProseMirror) и привязка к Yjs.
 * Модуль грузится динамическим import() из rich-text-editor.tsx отдельным
 * чанком — экраны без редактора его не скачивают (как CodeMirror у SqlEditor).
 *
 * Строгий CSP (ADR-0043): Tiptap не вставляет свой <style> (injectCSS: false —
 * оформление в styles/rich-text.css), курсоры и выделения соавторов собираются
 * классами и data-атрибутами без атрибута style.
 */
import { type RichBody, safeHref } from '@kchs/contracts'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { formatShortcut } from '../../hooks/use-hotkeys.js'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { Button, IconButton } from '../../primitives/button.js'
import { Input } from '../../primitives/input.js'
import { Popover, PopoverAnchor, PopoverContent } from '../../primitives/overlays.js'
import type { Collaborator, RichTextEditorProps } from './types.js'

const EMPTY: RichBody = { type: 'doc', content: [] }
/** Невидимый разделитель вокруг подписи курсора: слово не переносится по курсору. */
const WORD_JOINER = String.fromCharCode(0x2060)

/** Курсор соавтора: вертикальная черта и подпись; цвет — класс по оттенку. */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement('span')
  caret.className = 'kchs-caret'
  caret.dataset.tone = String(user.tone ?? 1)
  caret.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'kchs-caret__label'
  label.textContent = String(user.name ?? '')
  caret.append(WORD_JOINER, label, WORD_JOINER)
  return caret
}

function renderSelection(user: Record<string, unknown>) {
  return { nodeName: 'span', class: 'kchs-caret-selection', 'data-tone': String(user.tone ?? 1) }
}

interface ToolbarState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  h1: boolean
  h2: boolean
  h3: boolean
  bulletList: boolean
  orderedList: boolean
  blockquote: boolean
  codeBlock: boolean
  link: boolean
  canUndo: boolean
  canRedo: boolean
}

function toolbarState(editor: Editor): ToolbarState {
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    h1: editor.isActive('heading', { level: 1 }),
    h2: editor.isActive('heading', { level: 2 }),
    h3: editor.isActive('heading', { level: 3 }),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    link: editor.isActive('link'),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  }
}

export default function RichTextEditorRuntime({
  value,
  onChange,
  collaboration,
  editable = true,
  placeholder,
  toolbar = 'always',
  autoFocus = false,
  className,
  onFocus,
  onBlur,
  'aria-label': label,
  'aria-describedby': describedBy,
}: RichTextEditorProps) {
  const t = useUiT()
  const fragment = collaboration?.fragment ?? null
  const awareness = collaboration?.awareness ?? null
  const user: Collaborator = collaboration?.user ?? { name: '', tone: 1 }
  const handlers = useRef({ onChange, onFocus, onBlur })
  handlers.current = { onChange, onFocus, onBlur }
  // Значение, которое редактор уже показывает: начальное или отданное им в onChange
  const shown = useRef(value)
  const [focused, setFocused] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  const editor = useEditor(
    {
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      editable,
      autofocus: autoFocus ? 'end' : false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          // В совместном режиме историю правок ведёт Yjs: отмена — только своих правок
          ...(fragment ? { undoRedo: false as const } : {}),
          dropcursor: { class: 'kchs-rich-text__dropcursor', color: false },
          link: {
            openOnClick: false,
            autolink: true,
            defaultProtocol: 'https',
            isAllowedUri: (url) => Boolean(safeHref(url)),
            HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
          },
        }),
        Placeholder.configure({ placeholder: placeholder ?? t('ui.richText.placeholder') }),
        ...(fragment ? [Collaboration.configure({ fragment })] : []),
        ...(fragment && awareness
          ? [
              CollaborationCaret.configure({
                provider: { awareness },
                user,
                render: renderCaret,
                selectionRender: renderSelection,
              }),
            ]
          : []),
      ],
      ...(fragment ? {} : { content: value ?? EMPTY }),
      editorProps: {
        attributes: {
          class: 'kchs-rich-text__content',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label,
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
          ...(editable ? {} : { 'aria-readonly': 'true' }),
        },
      },
      onUpdate: ({ editor: current }) => {
        if (fragment) return
        const next = current.getJSON() as RichBody
        shown.current = next
        handlers.current.onChange?.(next)
      },
    },
    // Другой документ или присутствие — новый редактор
    [fragment, awareness],
  )

  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  // Имя и цвет автора видят соавторы — обновляются без пересоздания редактора
  const { name: userName, tone: userTone } = user
  useEffect(() => {
    if (fragment && awareness) editor.commands.updateUser({ name: userName, tone: userTone })
  }, [editor, fragment, awareness, userName, userTone])

  // Несовместный режим: новое значение снаружи (не то, что редактор показывает или
  // сам отдал в onChange) — в редактор; своё эхо не сбрасывает выделение и историю
  useEffect(() => {
    if (fragment || !value || value === shown.current) return
    shown.current = value
    editor.commands.setContent(value, { emitUpdate: false })
  }, [editor, fragment, value])

  const showToolbar =
    editable && (toolbar === 'always' || (toolbar === 'focus' && (focused || linkOpen)))

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: контейнер только следит, где фокус (focusin/focusout текста и панели), сам он не интерактивен
    <div
      className={cn('relative flex min-w-0 flex-col gap-1.5', className)}
      data-rich-text-state="ready"
      onFocus={() => {
        if (!focused) {
          setFocused(true)
          handlers.current.onFocus?.()
        }
      }}
      onBlur={(event) => {
        // Фокус ушёл на панель или в окно ссылки — редактор остаётся «в работе»
        if (event.currentTarget.contains(event.relatedTarget as Node | null) || linkOpen) return
        setFocused(false)
        handlers.current.onBlur?.()
      }}
    >
      {showToolbar ? (
        <Toolbar
          editor={editor}
          floating={toolbar === 'focus'}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
        />
      ) : null}
      <EditorContent editor={editor} />
    </div>
  )
}

function Toolbar({
  editor,
  floating,
  linkOpen,
  onLinkOpenChange,
}: {
  editor: Editor
  /** Панель при фокусе висит над текстом: её появление не сдвигает строки под курсором. */
  floating: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}) {
  const t = useUiT()
  const state = useEditorState({ editor, selector: ({ editor: current }) => toolbarState(current) })

  // Стрелки влево и вправо переводят фокус между кнопками панели
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'ArrowRight' ? index + 1 : index - 1
    buttons[(next + buttons.length) % buttons.length]?.focus()
  }

  const tool = (
    key: string,
    icon: ReactNode,
    active: boolean,
    run: () => void,
    shortcut?: string,
    disabled = false,
  ) => (
    <IconButton
      key={key}
      size="sm"
      label={t(`ui.richText.${key}`)}
      active={active}
      aria-pressed={active}
      disabled={disabled}
      {...(shortcut
        ? {
            'aria-keyshortcuts': shortcut.replace('Mod', 'Control'),
            title: `${t(`ui.richText.${key}`)} (${formatShortcut(shortcut)})`,
          }
        : {})}
      // Нажатие не забирает фокус и выделение у текста
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      {icon}
    </IconButton>
  )

  const chain = () => editor.chain().focus()
  return (
    <div
      role="toolbar"
      aria-label={t('ui.richText.toolbar')}
      className={cn(
        'flex flex-wrap items-center gap-0.5 rounded-sm border border-line p-0.5',
        floating
          ? 'absolute bottom-full left-0 z-(--z-dropdown) mb-1 bg-overlay shadow-md'
          : 'bg-surface-2',
      )}
      onKeyDown={onKeyDown}
    >
      {tool(
        'bold',
        <Bold className="size-3.5" />,
        state.bold,
        () => chain().toggleBold().run(),
        'Mod+B',
      )}
      {tool(
        'italic',
        <Italic className="size-3.5" />,
        state.italic,
        () => chain().toggleItalic().run(),
        'Mod+I',
      )}
      {tool(
        'underline',
        <Underline className="size-3.5" />,
        state.underline,
        () => chain().toggleUnderline().run(),
        'Mod+U',
      )}
      {tool('strike', <Strikethrough className="size-3.5" />, state.strike, () =>
        chain().toggleStrike().run(),
      )}
      {tool(
        'code',
        <Code className="size-3.5" />,
        state.code,
        () => chain().toggleCode().run(),
        'Mod+E',
      )}
      <Divider />
      {tool('heading1', <Heading1 className="size-3.5" />, state.h1, () =>
        chain().toggleHeading({ level: 1 }).run(),
      )}
      {tool('heading2', <Heading2 className="size-3.5" />, state.h2, () =>
        chain().toggleHeading({ level: 2 }).run(),
      )}
      {tool('heading3', <Heading3 className="size-3.5" />, state.h3, () =>
        chain().toggleHeading({ level: 3 }).run(),
      )}
      <Divider />
      {tool('bulletList', <List className="size-3.5" />, state.bulletList, () =>
        chain().toggleBulletList().run(),
      )}
      {tool('orderedList', <ListOrdered className="size-3.5" />, state.orderedList, () =>
        chain().toggleOrderedList().run(),
      )}
      {tool('blockquote', <Quote className="size-3.5" />, state.blockquote, () =>
        chain().toggleBlockquote().run(),
      )}
      {tool('codeBlock', <SquareCode className="size-3.5" />, state.codeBlock, () =>
        chain().toggleCodeBlock().run(),
      )}
      <LinkTool
        editor={editor}
        active={state.link}
        open={linkOpen}
        onOpenChange={onLinkOpenChange}
      />
      <Divider />
      {tool(
        'undo',
        <Undo2 className="size-3.5" />,
        false,
        () => chain().undo().run(),
        'Mod+Z',
        !state.canUndo,
      )}
      {tool(
        'redo',
        <Redo2 className="size-3.5" />,
        false,
        () => chain().redo().run(),
        'Mod+Shift+Z',
        !state.canRedo,
      )}
    </div>
  )
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
}

/** Ссылка на выделенный текст: адрес проверяется (http(s), почта, телефон, путь приложения). */
function LinkTool({
  editor,
  active,
  open,
  onOpenChange,
}: {
  editor: Editor
  active: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useUiT()
  const id = useId()
  const [href, setHref] = useState('')
  const [invalid, setInvalid] = useState(false)

  const openWith = (next: boolean) => {
    if (next) {
      setHref(String(editor.getAttributes('link').href ?? ''))
      setInvalid(false)
    }
    onOpenChange(next)
    // Окно закрыто (Escape, щелчок мимо) — фокус возвращается в текст
    if (!next) editor.commands.focus()
  }

  const apply = (event: FormEvent) => {
    event.preventDefault()
    const safe = safeHref(href)
    if (!safe) {
      setInvalid(true)
      return
    }
    const chain = editor.chain().focus().extendMarkRange('link')
    if (editor.state.selection.empty && !active) {
      chain
        .insertContent({
          type: 'text',
          text: safe,
          marks: [{ type: 'link', attrs: { href: safe } }],
        })
        .run()
    } else {
      chain.setLink({ href: safe }).run()
    }
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={openWith}>
      <PopoverAnchor asChild>
        <IconButton
          size="sm"
          label={t('ui.richText.link')}
          active={active}
          aria-pressed={active}
          aria-expanded={open}
          aria-haspopup="dialog"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openWith(!open)}
        >
          <Link2 className="size-3.5" />
        </IconButton>
      </PopoverAnchor>
      <PopoverContent className="w-80" aria-label={t('ui.richText.link')}>
        <form className="flex flex-col gap-2" onSubmit={apply}>
          <label htmlFor={`${id}-href`} className="text-xs font-medium text-fg-secondary">
            {t('ui.richText.linkAddress')}
          </label>
          <Input
            id={`${id}-href`}
            autoFocus
            value={href}
            invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : undefined}
            placeholder="https://"
            onChange={(event) => {
              setHref(event.target.value)
              setInvalid(false)
            }}
          />
          {invalid ? (
            <p id={`${id}-error`} className="text-xs text-danger">
              {t('ui.richText.linkInvalid')}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {active ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run()
                  onOpenChange(false)
                }}
              >
                {t('ui.richText.unlink')}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="sm">
              {t('ui.richText.linkApply')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
