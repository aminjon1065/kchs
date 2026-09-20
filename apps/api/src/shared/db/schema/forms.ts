import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { datasets } from './data.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Формы сбора данных (06-analytics-engine.md §13, ADR-0103). Форма — объект
 * реестра (`objects.type = 'form'`), здесь — её определение и привязка к
 * датасету. Строки датасета пишет модуль `data` по публичному API: своих
 * таблиц с данными у форм нет.
 */
export const forms = pgTable(
  'forms',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    definition: jsonbObject('definition'),
    enabled: boolean('enabled').notNull().default(false),
    /**
     * От чьего имени пишутся строки датасета: назначенный заполняет форму, а
     * доступ к датасету проверяется правами этого пользователя (ADR-0103).
     */
    runAs: uuid('run_as').references(() => users.id, { onDelete: 'set null' }),
    /** Денормализовано из определения: выборка периодов заданием. */
    periodicity: text('periodicity').notNull().default('monthly'),
    /**
     * Денормализовано из определения и назначений: политика типа (видимость
     * назначенным и ответственным) и списки читают массивы, а не JSON.
     */
    assignedUnits: uuid('assigned_units').array().notNull().default(sql`'{}'::uuid[]`),
    assignedUsers: uuid('assigned_users').array().notNull().default(sql`'{}'::uuid[]`),
    /** Ответственные за приёмку: выражения назначений, разобранные в людей. */
    reviewers: uuid('reviewers').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('forms_dataset_idx').on(t.datasetId), index('forms_enabled_idx').on(t.enabled)],
)

/**
 * Отправка формы: сводка одного назначенного за один период. Черновик, сдача,
 * приёмка и возврат — состояния одной строки; `row_id` — строка датасета,
 * записанная отправкой (`_import_id` строки равен `id` отправки).
 */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: uuid('id').primaryKey(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /** Ключ периода: `2026-09-19`, `2026-W38`, `2026-09`, `once`. */
    periodKey: text('period_key').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    dueAt: tsCol('due_at'),
    subjectKind: text('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    status: text('status').notNull().default('draft'),
    values: jsonbObject('values'),
    /** `_id` строки датасета в виде строки: у строк датасетов ключ — bigint. */
    rowId: text('row_id'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: tsCol('submitted_at'),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tsCol('reviewed_at'),
    comment: text('comment'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('form_submissions_period_uq').on(t.formId, t.periodKey, t.subjectKind, t.subjectId),
    index('form_submissions_due_idx').on(t.status, t.dueAt),
    index('form_submissions_subject_idx').on(t.subjectKind, t.subjectId, t.status),
  ],
)

/**
 * Отметка отправленного этапа напоминания по отправке (как `task_reminders` у
 * поручений): повтор задания, два воркера и перезапуск не дают дублей.
 */
export const formReminders = pgTable(
  'form_reminders',
  {
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => formSubmissions.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    dueAt: tsCol('due_at').notNull(),
    /** Этап наступил, но устарел: отмечен без отправки. */
    skipped: boolean('skipped').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('form_reminders_uq').on(t.submissionId, t.stage, t.dueAt)],
)
