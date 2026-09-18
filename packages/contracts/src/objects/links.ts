import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { ObjectSummary } from './object.js'

/** Виды связей (02-platform-kernel.md §3). */
export const LINK_KINDS = [
  'related',
  'attachment',
  'source',
  'mention',
  'reply_to',
  'in_execution_of',
  'cancels',
  'amends',
  'about_territory',
  'about_feature',
] as const
export const LinkKind = z.enum(LINK_KINDS)
export type LinkKind = z.infer<typeof LinkKind>

export const Link = z.object({
  id: Uuid,
  sourceId: Uuid,
  targetId: Uuid,
  kind: LinkKind,
  createdBy: Uuid.nullable(),
  createdAt: Timestamp,
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type Link = z.infer<typeof Link>

/** Связь в виде, пригодном для панели «Связи»: с направлением и сводкой. */
export const LinkView = z.object({
  id: Uuid,
  kind: LinkKind,
  direction: z.enum(['outgoing', 'incoming']),
  object: ObjectSummary,
  createdAt: Timestamp,
  createdBy: Uuid.nullable(),
})
export type LinkView = z.infer<typeof LinkView>

export const LinkCreateInput = z.object({
  targetId: Uuid,
  kind: LinkKind.default('related'),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type LinkCreateInput = z.infer<typeof LinkCreateInput>

/** Вычисляемые зависимости «использует» — происхождение и анализ влияния. */
export const DEPENDENCY_KINDS = ['uses', 'derives_from', 'renders'] as const
export const DependencyKind = z.enum(DEPENDENCY_KINDS)
export const Dependency = z.object({
  fromId: Uuid,
  toId: Uuid,
  kind: DependencyKind,
})
export type Dependency = z.infer<typeof Dependency>
