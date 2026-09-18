import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { TaskStatus } from './task.js'

/**
 * Проект (10-tasks-projects.md §2): ключ задач (`FLD` → `FLD-12`), руководитель,
 * пространство участников, рабочий процесс задач. Объект реестра типа `project`,
 * его задачи — дочерние объекты и наследуют доступ.
 */
export const PROJECT_STATUSES = ['active', 'completed', 'archived'] as const
export const ProjectStatus = z.enum(PROJECT_STATUSES)
export type ProjectStatus = z.infer<typeof ProjectStatus>

/** Ключ проекта: 2–10 заглавных букв и цифр, с буквы (`FLD`, `ПАВ2`). */
export const ProjectKey = z
  .string()
  .trim()
  .regex(/^[A-ZА-ЯЁ][A-ZА-ЯЁ0-9]{1,9}$/, 'ключ проекта: 2–10 заглавных букв и цифр, с буквы')
export type ProjectKey = z.infer<typeof ProjectKey>

export const ProjectWorkflow = z.object({ statuses: z.array(TaskStatus).min(2) })
export type ProjectWorkflow = z.infer<typeof ProjectWorkflow>

export const ProjectCounts = z.object({
  open: z.number().int(),
  overdue: z.number().int(),
  closed: z.number().int(),
})

export const ProjectRecord = z.object({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatus,
  lead: UserRef.nullable(),
  spaceId: Uuid.nullable(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  workflow: ProjectWorkflow,
  counts: ProjectCounts,
  createdAt: Timestamp,
})
export type ProjectRecord = z.infer<typeof ProjectRecord>

export const ProjectCreateInput = z.object({
  key: ProjectKey,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).optional(),
  spaceId: Uuid,
  leadId: Uuid.optional(),
  startsAt: Timestamp.optional(),
  endsAt: Timestamp.optional(),
})
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>

export const ProjectUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5_000).nullable(),
    leadId: Uuid.nullable(),
    status: ProjectStatus,
    endsAt: Timestamp.nullable(),
  })
  .partial()
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>

export const ProjectListQuery = z.object({
  spaceId: Uuid.optional(),
  status: ProjectStatus.optional(),
})
export type ProjectListQuery = z.infer<typeof ProjectListQuery>
