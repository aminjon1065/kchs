import { z } from 'zod'
import { AccessMode } from '../access/acl.js'
import { Confidentiality } from '../access/confidentiality.js'
import { Level } from '../access/levels.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { TagView } from './tags.js'

/**
 * Типы объектов реестра — 05-appendix/glossary.md.
 * Ядро не знает о них ничего, кроме описания в реестре типов; этот список —
 * канонические идентификаторы для контрактов и клиента.
 */
export const OBJECT_TYPES = [
  // ядро
  'space',
  'folder',
  'view',
  'conversation',
  // данные
  'source',
  'dataset',
  'pipeline',
  'query',
  'metric',
  'chart',
  'dashboard',
  'notebook',
  'report',
  'form',
  'alert',
  // GIS
  'layer',
  'map',
  'territory',
  'analysis',
  'basemap',
  'service_layer',
  // документы
  'document',
  'document_type',
  'journal',
  'route',
  'template',
  'case',
  'correspondent',
  // файлы
  'file',
  // задачи
  'project',
  'task',
  'task_series',
  // встречи и календарь
  'meeting',
  'recording',
  'protocol',
  'calendar',
  'event',
  // знания и автоматизация
  'page',
  'rule',
  'integration',
  'webhook',
] as const
export const ObjectType = z.enum(OBJECT_TYPES)
export type ObjectType = z.infer<typeof ObjectType>

export const ObjectRef = z.object({
  id: Uuid,
  type: ObjectType,
})
export type ObjectRef = z.infer<typeof ObjectRef>

export const ObjectLifecycle = z.enum(['active', 'archived', 'trashed'])
export type ObjectLifecycle = z.infer<typeof ObjectLifecycle>

/** Краткая сводка для карточек, чипов, пикеров и панели «Связи». */
export const ObjectSummary = z.object({
  id: Uuid,
  type: ObjectType,
  title: z.string(),
  subtitle: z.string().nullable(),
  icon: z.string().nullable(),
  spaceId: Uuid.nullable(),
  spaceName: z.string().nullable().optional(),
  ownerId: Uuid.nullable(),
  updatedAt: Timestamp,
  lifecycle: ObjectLifecycle,
  /** Денормализованные поля для списков: статус, срок, исполнитель. */
  meta: z.record(z.string(), z.unknown()).default({}),
  url: z.string(),
  /** null — объект недоступен: показываем «Нет доступа» без названия. */
  accessible: z.boolean().default(true),
  /**
   * Действующий гриф: свой или самый строгий из объектов, к которым объект
   * прикреплён (ADR-0080). Уведомления о грифе от «конфиденциально» — без содержания.
   */
  confidentiality: Confidentiality.optional(),
})
export type ObjectSummary = z.infer<typeof ObjectSummary>

/** Полная карточка объекта из реестра — `/objects/{id}`. */
export const ObjectRecord = ObjectSummary.extend({
  parentId: Uuid.nullable(),
  createdBy: Uuid.nullable(),
  createdAt: Timestamp,
  archivedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  accessMode: AccessMode,
  version: z.number().int(),
  tags: z.array(TagView).default([]),
  breadcrumbs: z.array(z.object({ id: Uuid, type: ObjectType, title: z.string() })).default([]),
  /** Эффективный уровень доступа текущего пользователя. */
  level: Level,
  /** Разрешённые текущему пользователю действия модуля. */
  allowedActions: z.array(z.string()).default([]),
  favorite: z.boolean().default(false),
  subscribed: z.boolean().default(false),
})
export type ObjectRecord = z.infer<typeof ObjectRecord>

export const ObjectCreateInput = z.object({
  type: ObjectType,
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  title: z.string().min(1).max(500),
  subtitle: z.string().max(500).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type ObjectCreateInput = z.infer<typeof ObjectCreateInput>

export const ObjectPatchInput = z.object({
  title: z.string().min(1).max(500).optional(),
  subtitle: z.string().max(500).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  parentId: Uuid.nullable().optional(),
  spaceId: Uuid.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type ObjectPatchInput = z.infer<typeof ObjectPatchInput>

export const BatchGetInput = z.object({
  ids: z.array(Uuid).min(1).max(200),
})
export type BatchGetInput = z.infer<typeof BatchGetInput>
