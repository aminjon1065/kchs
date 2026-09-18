import { z } from 'zod'
import { LangText } from '../common/primitives.js'

/** Типы полей — contracts/field-types.md. Один словарь для датасетов, карточек
 * документов, пользовательских полей задач, форм сбора и параметров отчётов. */
export const FIELD_TYPES = [
  'text',
  'long_text',
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'boolean',
  'date',
  'datetime',
  'time',
  'duration',
  'select',
  'multi_select',
  'user',
  'unit',
  'territory',
  'object_ref',
  'file',
  'url',
  'email',
  'phone',
  'geometry',
  'json',
  'formula',
  'lookup',
  'rollup',
  'identifier',
  'signature',
] as const
export const FieldType = z.enum(FIELD_TYPES)
export type FieldType = z.infer<typeof FieldType>

export const FIELD_SEMANTICS = [
  'dimension',
  'measure',
  'identifier',
  'time',
  'geometry',
  'territory',
  'category',
  'text',
  'lookup',
  'system',
] as const
export const FieldSemantic = z.enum(FIELD_SEMANTICS)
export type FieldSemantic = z.infer<typeof FieldSemantic>

export const FieldOption = z.object({
  value: z.string(),
  label: LangText,
  color: z.string().optional(),
  icon: z.string().optional(),
})
export type FieldOption = z.infer<typeof FieldOption>

export const FieldFormat = z.object({
  precision: z.number().int().min(0).max(12).optional(),
  thousands: z.boolean().optional(),
  dateFormat: z.string().optional(),
  currency: z.string().length(3).optional(),
  scale: z.enum(['fraction', 'percent']).optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
})
export type FieldFormat = z.infer<typeof FieldFormat>

export const FieldValidation = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  pattern: z.string().optional(),
})

export const FieldCondition = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
})

export const FieldDef = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: snake_case'),
  label: LangText,
  type: FieldType,
  semantic: FieldSemantic.default('dimension'),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  nullable: z.boolean().default(true),
  description: z.string().max(1000).optional(),
  unit: z.string().max(32).nullable().optional(),
  format: FieldFormat.optional(),
  default: z.unknown().optional(),
  options: z.array(FieldOption).optional(),
  lookup: z
    .object({ datasetId: z.string(), keyField: z.string(), labelField: z.string() })
    .optional(),
  objectTypes: z.array(z.string()).optional(),
  geometryType: z.enum(['point', 'line', 'polygon', 'any']).optional(),
  expression: z.string().optional(),
  resultType: FieldType.optional(),
  relation: z.string().optional(),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
  validation: FieldValidation.optional(),
  visibleIf: FieldCondition.optional(),
  requiredIf: FieldCondition.optional(),
  order: z.number().int().default(0),
  group: z.string().max(120).optional(),
  placeholder: z.string().max(200).optional(),
  rich: z.boolean().optional(),
})
export type FieldDef = z.infer<typeof FieldDef>

/** Схема формы/карточки: набор полей + компоновка. */
export const FieldSchema = z.object({
  fields: z.array(FieldDef),
  groups: z
    .array(z.object({ key: z.string(), label: LangText, collapsed: z.boolean().default(false) }))
    .optional(),
  columns: z.union([z.literal(1), z.literal(2)]).default(2),
})
export type FieldSchema = z.infer<typeof FieldSchema>
