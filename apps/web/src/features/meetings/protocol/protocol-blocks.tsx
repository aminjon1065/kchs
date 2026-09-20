import type { ProtocolBlockKind, UserRef } from '@kchs/contracts'
import {
  Badge,
  type BadgeProps,
  Button,
  IconButton,
  Input,
  RichTextEditor,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type * as Y from 'yjs'
import { useT } from '~/app/i18n.js'
import {
  applyTextChange,
  type CellMap,
  useCellValue,
  useYChanges,
} from '~/features/notebooks/notebook-doc.js'
import { useProtocol } from './protocol-context.js'
import { bodyFragment, titleText } from './protocol-doc.js'

/** Значок вида блока: решение и поручение видно в ленте протокола сразу. */
const TONE: Record<ProtocolBlockKind, BadgeProps['tone']> = {
  agenda_item: 'neutral',
  decision: 'accent',
  instruction: 'warning',
  note: 'outline',
}

/** Заголовок блока: `Y.Text` — правки двух авторов сливаются посимвольно. */
function BlockTitle({ block, label }: { block: CellMap; label: string }) {
  const text = titleText(block)
  const { readOnly } = useProtocol()
  useYChanges(text as unknown as Y.AbstractType<unknown> | null)
  if (!text) return null
  return (
    <Input
      value={text.toString()}
      onChange={(event) => applyTextChange(text, event.target.value)}
      aria-label={label}
      placeholder={label}
      readOnly={readOnly}
      className="font-medium"
    />
  )
}

/** Исполнитель, контролёр и срок поручения — только участники встречи. */
function InstructionFields({ block }: { block: CellMap }) {
  const t = useT()
  const { readOnly, participants } = useProtocol()
  const assigneeId = useCellValue<string | null>(block, 'assigneeId') ?? null
  const controllerId = useCellValue<string | null>(block, 'controllerId') ?? null
  const dueAt = useCellValue<string | null>(block, 'dueAt') ?? null
  const taskId = useCellValue<string | null>(block, 'taskId') ?? null

  const person = (value: string | null, key: 'assigneeId' | 'controllerId') => (
    <Select
      value={value ?? 'none'}
      disabled={readOnly || Boolean(taskId)}
      onValueChange={(next) => block.set(key, next === 'none' ? null : next)}
    >
      <SelectTrigger
        aria-label={t(
          key === 'assigneeId' ? 'meetings.protocol.assignee' : 'meetings.protocol.controller',
        )}
      >
        <SelectValue placeholder={t('meetings.protocol.notChosen')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t('meetings.protocol.notChosen')}</SelectItem>
        {participants.map((user: UserRef) => (
          <SelectItem key={user.id} value={user.id}>
            {user.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {person(assigneeId, 'assigneeId')}
      {person(controllerId, 'controllerId')}
      <Input
        type="date"
        value={dueAt ?? ''}
        readOnly={readOnly || Boolean(taskId)}
        aria-label={t('meetings.protocol.due')}
        onChange={(event) => block.set('dueAt', event.target.value || null)}
      />
    </div>
  )
}

/** Блок протокола: заголовок, текст и — у поручения — исполнитель и срок. */
export function ProtocolBlockCard({
  block,
  kind,
  onMove,
  onRemove,
}: {
  block: CellMap
  kind: ProtocolBlockKind
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useT()
  const { readOnly, awareness, user } = useProtocol()
  const body = bodyFragment(block)
  const taskId = useCellValue<string | null>(block, 'taskId') ?? null
  const label = t(`meetings.protocol.kinds.${kind}`)

  return (
    <article className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <Badge tone={TONE[kind]}>{label}</Badge>
        <div className="flex-1" />
        {readOnly ? null : (
          <>
            <IconButton
              label={t('meetings.protocol.moveUp')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton
              label={t('meetings.protocol.moveDown')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton
              label={t('meetings.protocol.removeBlock')}
              size="sm"
              variant="ghost"
              disabled={Boolean(taskId)}
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </>
        )}
      </div>
      <BlockTitle block={block} label={label} />
      {body ? (
        <RichTextEditor
          aria-label={t('meetings.protocol.body')}
          placeholder={t('meetings.protocol.bodyPlaceholder')}
          toolbar="focus"
          editable={!readOnly}
          collaboration={{ fragment: body, awareness, user }}
        />
      ) : null}
      {kind === 'instruction' ? <InstructionFields block={block} /> : null}
    </article>
  )
}

/** Кнопки «добавить блок»: повестка ведётся до встречи, решения — после. */
export function AddBlockButtons({ onAdd }: { onAdd: (kind: ProtocolBlockKind) => void }) {
  const t = useT()
  const kinds: ProtocolBlockKind[] = ['agenda_item', 'decision', 'instruction', 'note']
  return (
    <div className="flex flex-wrap gap-2">
      {kinds.map((kind) => (
        <Button key={kind} size="sm" variant="secondary" onClick={() => onAdd(kind)}>
          {t(`meetings.protocol.add.${kind}`)}
        </Button>
      ))}
    </div>
  )
}
