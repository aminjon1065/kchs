import { type ProtocolBlock, richBodyText } from '@kchs/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { Executor } from '~/shared/db/client.js'
import { meetingParticipants, objects, protocols } from '~/shared/db/schema/index.js'

/**
 * Чтение протокола из базы (ADR-0093) — общее для карточки, черновика ИИ и
 * подтверждения: снимок блоков, итоги и участники встречи. Права проверяют
 * вызывающие службы через `authorize()`.
 */

export interface ProtocolRow {
  id: string
  meetingId: string
  status: string
  blocks: ProtocolBlock[]
  summary: string | null
  instructions: Record<string, string>
  documentId: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  acknowledgmentAt: string | null
  title: string
  spaceId: string | null
  version: number
  updatedAt: string
}

const select = (executor: Executor) =>
  executor
    .select({
      id: protocols.id,
      meetingId: protocols.meetingId,
      status: protocols.status,
      blocks: protocols.blocks,
      summary: protocols.summary,
      instructions: protocols.instructions,
      documentId: protocols.documentId,
      confirmedAt: protocols.confirmedAt,
      confirmedBy: protocols.confirmedBy,
      acknowledgmentAt: protocols.acknowledgmentAt,
      title: objects.title,
      spaceId: objects.spaceId,
      version: objects.version,
      updatedAt: objects.updatedAt,
    })
    .from(protocols)
    .innerJoin(objects, eq(objects.id, protocols.id))

export async function loadProtocol(executor: Executor, id: string): Promise<ProtocolRow | null> {
  const [row] = await select(executor).where(eq(protocols.id, id)).limit(1)
  return (row as ProtocolRow | undefined) ?? null
}

export async function protocolOfMeeting(
  executor: Executor,
  meetingId: string,
): Promise<ProtocolRow | null> {
  const [row] = await select(executor)
    .where(and(eq(protocols.meetingId, meetingId), isNull(objects.deletedAt)))
    .limit(1)
  return (row as ProtocolRow | undefined) ?? null
}

/** Участники встречи: им ознакомление, они же видят протокол (ACL встречи). */
export async function meetingParticipantIds(
  executor: Executor,
  meetingId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))
  return rows.map((row) => row.userId)
}

/** Текст протокола: резюме, заголовки и тело блоков — для поиска и документа. */
export function protocolText(blocks: readonly ProtocolBlock[], summary: string | null): string {
  const parts: string[] = summary ? [summary] : []
  for (const block of blocks) {
    if (block.title) parts.push(block.title)
    const body = richBodyText(block.body)
    if (body) parts.push(body)
  }
  return parts.join('\n')
}
