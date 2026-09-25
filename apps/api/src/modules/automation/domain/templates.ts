import type { RuleTemplate } from '@kchs/contracts'

/**
 * Галерея шаблонов правил (14-automation-integrations.md §1): готовые
 * определения, которые конструктор открывает как черновик. Служебного
 * пользователя (`runAs`) и получателей выбирает администратор — в шаблонах
 * их нет намеренно.
 */
export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    key: 'large-contract-notify',
    name: {
      ru: 'Крупный договор — уведомить финансистов',
      en: 'Large contract — notify finance',
    },
    description: {
      ru: 'Зарегистрирован договор на сумму от миллиона: уведомление и поручение на проверку.',
      en: 'A registered contract above one million: notification and a check instruction.',
    },
    category: 'documents',
    definition: {
      version: 1,
      name: {
        ru: 'Крупный договор — уведомить финансистов',
        en: 'Large contract — notify finance',
      },
      description: null,
      enabled: false,
      runAs: null,
      trigger: {
        kind: 'event',
        type: 'document.registered',
        filter: { 'object.type': 'document' },
      },
      conditions: { and: [{ expr: 'object.fields.amount >= 1000000' }] },
      actions: [
        {
          type: 'notify',
          to: ['role:data_steward'],
          text: 'Зарегистрирован крупный договор {{object.title}}',
          channels: ['app'],
          object: '{{object.id}}',
          urgent: false,
        },
        {
          type: 'add_tag',
          tag: 'крупный',
          object: '{{object.id}}',
        },
      ],
      limits: { maxRunsPerHour: 100, dedupeKey: '{{object.id}}', dedupeWindowMinutes: 60 },
    },
  },
  {
    key: 'overdue-task-escalate',
    name: { ru: 'Просроченное поручение — руководителю', en: 'Overdue task — escalate' },
    description: {
      ru: 'Поручение просрочено: уведомление руководителю исполнителя.',
      en: 'A task is overdue: notify the assignee’s manager.',
    },
    category: 'tasks',
    definition: {
      version: 1,
      name: { ru: 'Просроченное поручение — руководителю', en: 'Overdue task — escalate' },
      description: null,
      enabled: false,
      runAs: null,
      trigger: { kind: 'event', type: 'task.overdue', filter: {} },
      conditions: null,
      actions: [
        {
          type: 'notify',
          to: ['manager(field:assigneeId)'],
          text: 'Просрочено поручение «{{object.title}}»',
          channels: ['app', 'telegram'],
          object: '{{object.id}}',
          // Эскалация проходит сквозь тихие часы руководителя (ADR-0140)
          urgent: true,
        },
      ],
      limits: { maxRunsPerHour: 200, dedupeKey: '{{object.id}}', dedupeWindowMinutes: 1440 },
    },
  },
  {
    key: 'weekly-digest',
    name: { ru: 'Еженедельная сводка по понедельникам', en: 'Weekly digest on Mondays' },
    description: {
      ru: 'Каждый понедельник в 9:00 — письмо ответственным.',
      en: 'Every Monday at 9:00 — an email to the owners.',
    },
    category: 'general',
    definition: {
      version: 1,
      name: { ru: 'Еженедельная сводка', en: 'Weekly digest' },
      description: null,
      enabled: false,
      runAs: null,
      trigger: { kind: 'schedule', cron: '0 9 * * 1', timezone: 'Asia/Dushanbe', objectId: null },
      conditions: null,
      actions: [
        {
          type: 'send_email',
          to: ['role:employee'],
          subject: 'Сводка за неделю',
          body: 'Сводка сформирована {{now}}.',
        },
      ],
      limits: { maxRunsPerHour: 10, dedupeKey: null, dedupeWindowMinutes: 60 },
    },
  },
  {
    key: 'manual-ai-summary',
    name: { ru: 'Кнопка «Краткое содержание»', en: 'Button “Summarize”' },
    description: {
      ru: 'Ручной запуск у документа: ИИ пишет краткое содержание в обсуждение.',
      en: 'Manual run on a document: AI posts a summary into the discussion.',
    },
    category: 'documents',
    definition: {
      version: 1,
      name: { ru: 'Краткое содержание документа', en: 'Document summary' },
      description: null,
      enabled: false,
      runAs: null,
      trigger: { kind: 'manual', objectTypes: ['document'], confirm: false },
      conditions: null,
      actions: [
        {
          type: 'ai_task',
          prompt: 'Кратко изложи суть документа «{{object.title}}» в трёх предложениях.',
          target: { kind: 'comment' },
          object: '{{object.id}}',
        },
      ],
      limits: { maxRunsPerHour: 50, dedupeKey: null, dedupeWindowMinutes: 60 },
    },
  },
  {
    key: 'metric-threshold-alert',
    name: { ru: 'Показатель вышел за порог', en: 'Metric crossed a threshold' },
    description: {
      ru: 'Ежедневная проверка показателя: значение выше порога — уведомление.',
      en: 'A daily metric check: a notification when the value is above the threshold.',
    },
    category: 'data',
    definition: {
      version: 1,
      name: { ru: 'Показатель вышел за порог', en: 'Metric crossed a threshold' },
      description: null,
      enabled: false,
      runAs: null,
      trigger: {
        kind: 'metric',
        metricId: '00000000-0000-7000-8000-000000000000',
        condition: 'value > 100',
        cron: '0 8 * * *',
        timezone: 'Asia/Dushanbe',
      },
      conditions: null,
      actions: [
        {
          type: 'notify',
          to: ['role:data_steward'],
          text: 'Показатель {{event.payload.name}}: {{event.payload.value}}',
          channels: ['app'],
          object: '{{object.id}}',
          urgent: false,
        },
      ],
      limits: { maxRunsPerHour: 10, dedupeKey: null, dedupeWindowMinutes: 60 },
    },
  },
]
