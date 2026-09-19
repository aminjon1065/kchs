import type { RichBody } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { personTone } from '../../lib/person-tone.js'
import { RichTextEditor } from './index.js'

const meta = {
  title: 'Композиты/Редактор текста',
  id: 'composites-rich-text-editor',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const REPORT: RichBody = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Паводки: сводка за неделю' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Уровень воды в Вахше ' },
        { type: 'text', text: 'выше нормы', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' на 40 см; подробности — в ' },
        {
          type: 'text',
          text: 'сводке',
          marks: [{ type: 'link', attrs: { href: 'https://kchs.tj/svodka' } }],
        },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'bulletList',
      content: ['Хатлон — 12 обращений', 'Согд — 4 обращения'].map((text) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    },
    {
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Проверить дамбы до пятницы.' }] },
      ],
    },
  ],
}

/** Редактор загружен (ленивый чанк Tiptap) и нарисован. */
async function editorReady(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () =>
      expect(canvasElement.querySelector('[data-rich-text-state]')).toHaveAttribute(
        'data-rich-text-state',
        'ready',
      ),
    { timeout: 15_000 },
  )
  await waitFor(() => expect(canvasElement.querySelector('.ProseMirror')).not.toBeNull())
}

function Plain({
  initial,
  ...props
}: {
  initial: RichBody
  editable?: boolean
  toolbar?: 'always' | 'focus' | 'none'
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="w-[640px]">
      <RichTextEditor aria-label="Сводка" value={value} onChange={setValue} {...props} />
    </div>
  )
}

export const Default: Story = {
  name: 'Обычный',
  render: () => <Plain initial={REPORT} />,
  play: async ({ canvasElement }) => editorReady(canvasElement),
}

export const Empty: Story = {
  name: 'Пустой — подсказка',
  render: () => <Plain initial={{ type: 'doc', content: [] }} />,
  play: async ({ canvasElement }) => editorReady(canvasElement),
}

export const ReadOnly: Story = {
  name: 'Только чтение',
  render: () => <Plain initial={REPORT} editable={false} />,
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
    await expect(within(canvasElement).getByRole('textbox', { name: 'Сводка' })).toHaveAttribute(
      'aria-readonly',
      'true',
    )
  },
}

export const ToolbarOnFocus: Story = {
  name: 'Панель при фокусе',
  // Панель висит над текстом — место над редактором
  render: () => (
    <div className="pt-12">
      <Plain initial={REPORT} toolbar="focus" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole('toolbar')).toBeNull()
    // Фокус без щелчка мышью ставит курсор в начало — в заголовок
    await userEvent.click(canvas.getByRole('textbox', { name: 'Сводка' }))
    await expect(
      await canvas.findByRole('toolbar', { name: 'Форматирование текста' }),
    ).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Заголовок 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  },
}

// ─── Совместная правка ───────────────────────────────────────────────────────

/** Текст отчёта во фрагменте Yjs — как его хранит тетрадь (раскладка y-prosemirror). */
function seed(fragment: Y.XmlFragment): void {
  const heading = new Y.XmlElement('heading')
  heading.setAttribute('level', 2 as unknown as string)
  heading.insert(0, [new Y.XmlText('Паводки: сводка за неделю')])
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  paragraph.insert(0, [text])
  fragment.insert(0, [heading, paragraph])
  text.insert(0, 'Уровень воды в Вахше выше нормы на 40 см, дамбы проверяются.', {})
}

/** Соавтор с курсором и выделением во втором абзаце: состояние его awareness — у нас. */
function useRemoteCollaborator(doc: Y.Doc, local: Awareness, name: string) {
  useEffect(() => {
    const remoteDoc = new Y.Doc()
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc))
    const remote = new Awareness(remoteDoc)
    const paragraph = remoteDoc.getXmlFragment('body').get(1) as Y.XmlElement
    const text = paragraph.get(0) as Y.XmlText
    const position = (index: number) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index))
    // Курсоры рисуются, когда редактор связан с документом: ждём его на странице
    const timer = window.setInterval(() => {
      if (!document.querySelector('.kchs-rich-text__content')) return
      window.clearInterval(timer)
      remote.setLocalState({
        user: { name, tone: personTone(name) },
        cursor: { anchor: position(21), head: position(31) },
      })
      applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remoteDoc.clientID]), 'remote')
    }, 20)
    return () => {
      window.clearInterval(timer)
      remote.destroy()
      remoteDoc.destroy()
    }
  }, [doc, local, name])
}

function Collaborative() {
  const { doc, awareness } = useMemo(() => {
    const created = new Y.Doc()
    seed(created.getXmlFragment('body'))
    return { doc: created, awareness: new Awareness(created) }
  }, [])
  useRemoteCollaborator(doc, awareness, 'Алия Каримова')
  const user = { name: 'Бахром Назаров', tone: personTone('Бахром Назаров') }
  return (
    <div className="w-[640px] pt-6">
      <RichTextEditor
        aria-label="Сводка"
        collaboration={{ fragment: doc.getXmlFragment('body'), awareness, user }}
      />
    </div>
  )
}

export const Collaboration: Story = {
  name: 'Совместная правка — курсор соавтора',
  render: () => <Collaborative />,
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
    await waitFor(() =>
      expect(canvasElement.querySelector('.kchs-caret__label')?.textContent).toBe('Алия Каримова'),
    )
    await expect(canvasElement.querySelector('.kchs-caret-selection')?.textContent).toBe(
      'выше нормы',
    )
  },
}

/** Два автора в одном документе: обновления и присутствие ходят между ними, как через сервер. */
function TwoAuthorsDemo() {
  const peers = useMemo(() => {
    const left = new Y.Doc()
    seed(left.getXmlFragment('body'))
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    const docs = [left, right] as const
    const awareness = docs.map((doc) => new Awareness(doc)) as [Awareness, Awareness]
    docs.forEach((doc, index) => {
      const other = docs[1 - index] as Y.Doc
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'peer') Y.applyUpdate(other, update, 'peer')
      })
    })
    awareness.forEach((current, index) => {
      const other = awareness[1 - index] as Awareness
      current.on(
        'update',
        (
          { added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>,
          origin: unknown,
        ) => {
          if (origin === 'peer') return
          const changed = [...added, ...updated, ...removed]
          applyAwarenessUpdate(other, encodeAwarenessUpdate(current, changed), 'peer')
        },
      )
    })
    return { docs, awareness }
  }, [])
  const authors = ['Бахром Назаров', 'Алия Каримова']
  return (
    <div className="grid w-[960px] grid-cols-2 gap-6 pt-6">
      {authors.map((name, index) => (
        <section key={name} aria-label={name} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">{name}</h3>
          <RichTextEditor
            aria-label={`Сводка — ${name}`}
            toolbar="none"
            collaboration={{
              fragment: (peers.docs[index] as Y.Doc).getXmlFragment('body'),
              awareness: peers.awareness[index] as Awareness,
              user: { name, tone: personTone(name) },
            }}
          />
        </section>
      ))}
    </div>
  )
}

export const TwoAuthors: Story = {
  name: 'Два соавтора',
  render: () => <TwoAuthorsDemo />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.ProseMirror')).toHaveLength(2), {
      timeout: 15_000,
    })
  },
}
