import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { RichBody } from '../discussions/message.js'

/**
 * Протокол встречи (11-communications-meetings.md §4, ADR-0093): объект
 * `protocol` — дочерний объекту встречи, тело — совместный документ Yjs со
 * структурными блоками. Повестку ведут до встречи, после встречи она же
 * становится протоколом: блоки `decision` и `instruction` дописываются, а
 * подтверждение превращает `instruction` в поручения (`Instructions.create`).
 */

export const PROTOCOL_BLOCK_KINDS = ['agenda_item', 'decision', 'instruction', 'note'] as const
export const ProtocolBlockKind = z.enum(PROTOCOL_BLOCK_KINDS)
export type ProtocolBlockKind = z.infer<typeof ProtocolBlockKind>

/** Блоков в протоколе — не больше: документ ведут люди, не машина. */
export const PROTOCOL_MAX_BLOCKS = 300

export const ProtocolBlockId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

const base = {
  id: ProtocolBlockId,
  /** Заголовок блока: вопрос повестки, суть решения, текст поручения. */
  title: z.string().max(500).default(''),
}

/** Вопрос повестки: его ведут до встречи, на нём держатся решения и поручения. */
export const ProtocolAgendaBlock = z.object({
  ...base,
  kind: z.literal('agenda_item'),
  body: RichBody.default({ type: 'doc', content: [] }),
  /** Докладчик по вопросу; null — не назначен. */
  speakerId: Uuid.nullable().default(null),
})

export const ProtocolDecisionBlock = z.object({
  ...base,
  kind: z.literal('decision'),
  body: RichBody.default({ type: 'doc', content: [] }),
})

/**
 * Поручение протокола: пока протокол не подтверждён — предложение (в том числе
 * от ИИ), после подтверждения — созданное поручение (`taskId`). Поле `taskId`
 * пишет сервер при подтверждении: до него блок — просто текст.
 */
export const ProtocolInstructionBlock = z.object({
  ...base,
  kind: z.literal('instruction'),
  body: RichBody.default({ type: 'doc', content: [] }),
  assigneeId: Uuid.nullable().default(null),
  /** Срок поручения, `ГГГГ-ММ-ДД`; null — не задан (подтвердить нельзя). */
  dueAt: DateOnly.nullable().default(null),
  controllerId: Uuid.nullable().default(null),
  /** Созданное поручение; null — ещё не создано. */
  taskId: Uuid.nullable().default(null),
})

/** Заметка: то, что в протокол входит, но решением и поручением не является. */
export const ProtocolNoteBlock = z.object({
  ...base,
  kind: z.literal('note'),
  body: RichBody.default({ type: 'doc', content: [] }),
})

export const ProtocolBlock = z.discriminatedUnion('kind', [
  ProtocolAgendaBlock,
  ProtocolDecisionBlock,
  ProtocolInstructionBlock,
  ProtocolNoteBlock,
])
export type ProtocolBlock = z.infer<typeof ProtocolBlock>
export type ProtocolInstructionBlock = z.infer<typeof ProtocolInstructionBlock>

/**
 * `agenda` — повестка до встречи; `draft` — протокол правится (в том числе
 * после ИИ-черновика); `confirmed` — подтверждён, поручения созданы.
 */
export const PROTOCOL_STATUSES = ['agenda', 'draft', 'confirmed'] as const
export const ProtocolStatus = z.enum(PROTOCOL_STATUSES)
export type ProtocolStatus = z.infer<typeof ProtocolStatus>

/** Поручение протокола в карточке: ключ, исполнитель, срок и состояние. */
export const ProtocolInstruction = z.object({
  blockId: ProtocolBlockId,
  taskId: Uuid,
  key: z.string(),
  title: z.string(),
  status: z.string(),
  assignee: UserRef.nullable(),
  dueAt: Timestamp.nullable(),
  /** Поручение видно смотрящему: иначе — только ключ и состояние. */
  accessible: z.boolean(),
})
export type ProtocolInstruction = z.infer<typeof ProtocolInstruction>

/** Что смотрящий может сделать с протоколом. */
export const ProtocolPermissions = z.object({
  edit: z.boolean(),
  /** Подтвердить: организатор, протокол ещё не подтверждён. */
  confirm: z.boolean(),
  /** Зарегистрировать документом и отправить на ознакомление — после подтверждения. */
  register: z.boolean(),
  requestAcknowledgment: z.boolean(),
  /** Черновик ИИ доступен: модель настроена, есть право и гриф позволяет. */
  draft: z.boolean(),
})
export type ProtocolPermissions = z.infer<typeof ProtocolPermissions>

export const ProtocolRecord = z.object({
  id: Uuid,
  meetingId: Uuid,
  title: z.string(),
  status: ProtocolStatus,
  /** Снимок совместного документа: отстаёт от открытого не больше чем на 10 с (ADR-0070). */
  blocks: z.array(ProtocolBlock),
  /** Резюме встречи из черновика ИИ; null — черновика не было. */
  summary: z.string().nullable(),
  /** Документ, которым зарегистрирован протокол. */
  documentId: Uuid.nullable(),
  confirmedAt: Timestamp.nullable(),
  confirmedBy: UserRef.nullable(),
  instructions: z.array(ProtocolInstruction),
  /** Ознакомление участников запрошено. */
  acknowledgmentRequested: z.boolean(),
  can: ProtocolPermissions,
  version: z.number().int(),
  updatedAt: Timestamp,
})
export type ProtocolRecord = z.infer<typeof ProtocolRecord>

/** Ответ карточки встречи: протокола может ещё не быть. */
export const ProtocolResponse = z.object({ protocol: ProtocolRecord.nullable() })
export type ProtocolResponse = z.infer<typeof ProtocolResponse>

/** Черновик ИИ: что модель предложила дописать (блоки уже в документе). */
export const ProtocolDraft = z.object({
  summary: z.string(),
  /** Дописанные блоки — их правит человек. */
  added: z.array(ProtocolBlock),
  /** Расшифровка учтена; false — черновик только по повестке. */
  usedTranscript: z.boolean(),
  /** Текст расшифровки обрезан по лимиту. */
  truncated: z.boolean(),
})
export type ProtocolDraft = z.infer<typeof ProtocolDraft>

/**
 * Почему черновик ИИ недоступен (как у документов, ADR-0088): `ai_disabled` —
 * модель не настроена или нет права; `confidentiality` — гриф встречи строже
 * порога установки; `empty` — ни повестки, ни расшифровки.
 */
export const PROTOCOL_DRAFT_BLOCKERS = ['ai_disabled', 'confidentiality', 'empty'] as const
export const ProtocolDraftBlocker = z.enum(PROTOCOL_DRAFT_BLOCKERS)
export type ProtocolDraftBlocker = z.infer<typeof ProtocolDraftBlocker>

/** Регистрация протокола документом: тип документа выбирает человек. */
export const ProtocolRegisterInput = z.object({ typeId: Uuid })
export type ProtocolRegisterInput = z.infer<typeof ProtocolRegisterInput>

/** Ознакомление: по умолчанию — все участники встречи. */
export const ProtocolAcknowledgeInput = z.object({
  userIds: z.array(Uuid).max(200).default([]),
  dueAt: DateOnly.nullable().default(null),
})
export type ProtocolAcknowledgeInput = z.infer<typeof ProtocolAcknowledgeInput>

// ─── Документ Yjs ────────────────────────────────────────────────────────────

/**
 * Раскладка документа Yjs протокола (ADR-0093), как у тетради (ADR-0071):
 * `blocks` — `Y.Map` блоков по идентификатору, `order` — `Y.Array` порядка,
 * `meta` — `Y.Map` резюме. Блок — `Y.Map` с ключами из раскладки его вида:
 * `rich` — `Y.XmlFragment` (текст Tiptap), `text` — `Y.Text` (заголовок:
 * правки двух авторов сливаются посимвольно), `json` — значение целиком.
 */
export const PROTOCOL_DOC = { blocks: 'blocks', order: 'order', meta: 'meta' } as const

/** Ключ резюме в `meta` документа: его пишет черновик ИИ, правит человек. */
export const PROTOCOL_SUMMARY_KEY = 'summary'

export type ProtocolValueKind = 'rich' | 'text' | 'json'

const COMMON_LAYOUT = { id: 'json', kind: 'json', title: 'text', body: 'rich' } as const

export const PROTOCOL_BLOCK_LAYOUT = {
  agenda_item: { ...COMMON_LAYOUT, speakerId: 'json' },
  decision: COMMON_LAYOUT,
  instruction: {
    ...COMMON_LAYOUT,
    assigneeId: 'json',
    dueAt: 'json',
    controllerId: 'json',
    taskId: 'json',
  },
  note: COMMON_LAYOUT,
} as const satisfies Record<ProtocolBlockKind, Record<string, ProtocolValueKind>>
