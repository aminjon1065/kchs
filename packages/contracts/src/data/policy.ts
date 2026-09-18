import { z } from 'zod'
import { Principal, PrincipalRef } from '../access/principals.js'
import { FilterNode } from '../common/filter.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Политики строк и столбцов датасета (03-access-model.md «Строки и столбцы
 * датасетов»). Действуют на пользователей ниже `manage`: политика строк —
 * фильтр общего формата над полями датасета (с макросами `@me`, `@my_unit`,
 * `@my_units`, `@my_territories`), политика столбцов — скрыть или замаскировать поля.
 */

/** Кому назначается политика: принципалы ACL, кроме гостевой ссылки. */
export const DatasetPolicyPrincipal = Principal.refine((principal) => principal.type !== 'link', {
  message: 'Политику нельзя назначить гостевой ссылке',
})

const FieldKey = z.string().min(1).max(64)
const Note = z.string().trim().max(500)

export const DatasetRowPolicy = z.object({
  id: Uuid,
  principal: PrincipalRef,
  filter: FilterNode,
  note: z.string().nullable(),
  createdAt: Timestamp,
})
export type DatasetRowPolicy = z.infer<typeof DatasetRowPolicy>

export const DATASET_COLUMN_POLICY_MODES = ['hide', 'mask'] as const
export const DatasetColumnPolicyMode = z.enum(DATASET_COLUMN_POLICY_MODES)
export type DatasetColumnPolicyMode = z.infer<typeof DatasetColumnPolicyMode>

export const DatasetColumnPolicy = z.object({
  id: Uuid,
  principal: PrincipalRef,
  mode: DatasetColumnPolicyMode,
  fields: z.array(z.string()),
  createdAt: Timestamp,
})
export type DatasetColumnPolicy = z.infer<typeof DatasetColumnPolicy>

export const DatasetPolicies = z.object({
  rows: z.array(DatasetRowPolicy),
  columns: z.array(DatasetColumnPolicy),
})
export type DatasetPolicies = z.infer<typeof DatasetPolicies>

export const DatasetRowPolicyInput = z.object({
  principal: DatasetPolicyPrincipal,
  filter: FilterNode,
  note: Note.nullish(),
})
export type DatasetRowPolicyInput = z.infer<typeof DatasetRowPolicyInput>

export const DatasetRowPolicyPatch = z
  .object({ principal: DatasetPolicyPrincipal, filter: FilterNode, note: Note.nullable() })
  .partial()
export type DatasetRowPolicyPatch = z.infer<typeof DatasetRowPolicyPatch>

export const DatasetColumnPolicyInput = z.object({
  principal: DatasetPolicyPrincipal,
  mode: DatasetColumnPolicyMode,
  fields: z.array(FieldKey).min(1).max(500),
})
export type DatasetColumnPolicyInput = z.infer<typeof DatasetColumnPolicyInput>

export const DatasetColumnPolicyPatch = DatasetColumnPolicyInput.partial()
export type DatasetColumnPolicyPatch = z.infer<typeof DatasetColumnPolicyPatch>
