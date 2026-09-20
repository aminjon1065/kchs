import { FORM_PERIODICITIES } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { FormJobs } from './domain/form-jobs.js'
import { formPolicy } from './domain/form-policy.js'
import { FormService } from './domain/form-service.js'
import { formSubscribers } from './domain/form-subscribers.js'
import { SubmissionService } from './domain/submission-service.js'

export { registerFormRoutes } from './http.js'

/**
 * Формы сбора данных (06-analytics-engine.md §13, ADR-0103). Форма — объект
 * реестра: права как у всех объектов, видимость назначенным и ответственным —
 * политикой типа. Строки датасета пишет модуль `data` по публичному API.
 */
export function registerFormObjectTypes(): void {
  registerObjectType({
    type: 'form',
    labelKey: 'objects.types.form',
    icon: 'clipboard-pen',
    route: (id) => `/o/${id}`,
    levels: ['view', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      /** Заполнить и сдать сводку: назначенному хватает просмотра. */
      submit: { minLevel: 'view' },
      /** Принять или вернуть сводку: ответственному политика даёт `edit`. */
      review: { minLevel: 'edit' },
      edit: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    policy: formPolicy,
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    searchable: (id) => FormService.searchable(id),
    listFields: [
      {
        key: 'enabled',
        labelKey: 'forms.fields.enabled',
        type: 'boolean',
        sql: sql`(${objects.meta}->>'enabled')::boolean`,
        sortable: true,
      },
      {
        key: 'periodicity',
        labelKey: 'forms.fields.periodicity',
        type: 'select',
        sql: sql`${objects.meta}->>'periodicity'`,
        options: FORM_PERIODICITIES.map((value) => ({
          value,
          labelKey: `forms.periodicity.${value}`,
        })),
      },
    ],
  })

  // Приёмка сводки из Входящих, из уведомления и из Telegram — одним путём
  registerInboxActionHandler('review_form', async (ctx, { item, action, comment }) => {
    const submissionId = item.payload.submissionId
    if (typeof submissionId !== 'string') throw errors.validation('В деле нет отправки')
    await SubmissionService.review(ctx, submissionId, {
      decision: action === 'accept' ? 'accept' : 'return',
      comment: comment ?? null,
    })
  })
}

/** Подписчики и задания контроля сдачи — только в роли worker. */
export function registerFormsBackground(): void {
  for (const subscriber of formSubscribers) registerSubscriber(subscriber)

  registerJobHandler({
    queue: 'maintenance',
    name: 'forms.control',
    concurrency: 1,
    handle: async () => ({ ...(await FormJobs.control()) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'forms.prune',
    concurrency: 1,
    handle: async () => ({ deleted: await FormJobs.prune() }),
  })
}

/** Регулярные задания форм — через единый планировщик ядра (ADR-0096). */
export function scheduleFormsJobs(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'forms.control',
    // Каждые полчаса: периоды открываются и сроки наступают с точностью до него
    pattern: '5,35 * * * *',
    labelKey: 'schedules.jobs.formsControl',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'forms.prune',
    pattern: '52 3 * * *',
    labelKey: 'schedules.jobs.formsPrune',
  })
}
