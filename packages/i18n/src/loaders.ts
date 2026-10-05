import type { CoreNamespace, ModuleNamespace } from './namespaces.js'
import type { Locale } from './resources.js'

// Загрузчики словарей входа браузера (ADR-0191). Vite кладёт каждый модульный неймспейс
// языка в свой чанк, неймспейсы оболочки `tg` и `en` — в один чанк на язык, а `ru`
// оболочки — в основной чанк. Чанки называются `i18n-<язык>-<файл>-<хэш>.js`
// (`apps/web/vite.config.ts`). Что загрузчик отдаёт свой неймспейс, проверяет `i18n:check`.

type Loader = () => Promise<object>

/** Неймспейсы оболочки `tg` и `en`: грузятся вместе с выбором языка. */
export const CORE_LOADERS: Record<
  Exclude<Locale, 'ru'>,
  () => Promise<Record<CoreNamespace, object>>
> = {
  tg: () => import('./locales/tg/core.js').then((module) => module.core),
  en: () => import('./locales/en/core.js').then((module) => module.core),
}

/** Модульные неймспейсы: грузятся с экраном модуля, который их объявил. */
export const MODULE_LOADERS: Record<Locale, Record<ModuleNamespace, Loader>> = {
  ru: {
    notifications: () =>
      import('./locales/ru/notifications.js').then((module) => module.notifications),
    telegram: () => import('./locales/ru/telegram.js').then((module) => module.telegram),
    documents: () => import('./locales/ru/documents.js').then((module) => module.documents),
    gis: () => import('./locales/ru/gis.js').then((module) => module.gis),
    data: () => import('./locales/ru/data.js').then((module) => module.data),
    tasks: () => import('./locales/ru/tasks.js').then((module) => module.tasks),
    processes: () => import('./locales/ru/processes.js').then((module) => module.processes),
    processDesigner: () =>
      import('./locales/ru/processDesigner.js').then((module) => module.processDesigner),
    documentAssist: () =>
      import('./locales/ru/documentAssist.js').then((module) => module.documentAssist),
    calendar: () => import('./locales/ru/calendar.js').then((module) => module.calendar),
    chats: () => import('./locales/ru/chats.js').then((module) => module.chats),
    meetings: () => import('./locales/ru/meetings.js').then((module) => module.meetings),
    assistant: () => import('./locales/ru/assistant.js').then((module) => module.assistant),
    knowledge: () => import('./locales/ru/knowledge.js').then((module) => module.knowledge),
    profile: () => import('./locales/ru/profile.js').then((module) => module.profile),
    admin: () => import('./locales/ru/admin.js').then((module) => module.admin),
    automation: () => import('./locales/ru/automation.js').then((module) => module.automation),
    forms: () => import('./locales/ru/forms.js').then((module) => module.forms),
    alerts: () => import('./locales/ru/alerts.js').then((module) => module.alerts),
    schedules: () => import('./locales/ru/schedules.js').then((module) => module.schedules),
  },
  tg: {
    notifications: () =>
      import('./locales/tg/notifications.js').then((module) => module.notifications),
    telegram: () => import('./locales/tg/telegram.js').then((module) => module.telegram),
    documents: () => import('./locales/tg/documents.js').then((module) => module.documents),
    gis: () => import('./locales/tg/gis.js').then((module) => module.gis),
    data: () => import('./locales/tg/data.js').then((module) => module.data),
    tasks: () => import('./locales/tg/tasks.js').then((module) => module.tasks),
    processes: () => import('./locales/tg/processes.js').then((module) => module.processes),
    processDesigner: () =>
      import('./locales/tg/processDesigner.js').then((module) => module.processDesigner),
    documentAssist: () =>
      import('./locales/tg/documentAssist.js').then((module) => module.documentAssist),
    calendar: () => import('./locales/tg/calendar.js').then((module) => module.calendar),
    chats: () => import('./locales/tg/chats.js').then((module) => module.chats),
    meetings: () => import('./locales/tg/meetings.js').then((module) => module.meetings),
    assistant: () => import('./locales/tg/assistant.js').then((module) => module.assistant),
    knowledge: () => import('./locales/tg/knowledge.js').then((module) => module.knowledge),
    profile: () => import('./locales/tg/profile.js').then((module) => module.profile),
    admin: () => import('./locales/tg/admin.js').then((module) => module.admin),
    automation: () => import('./locales/tg/automation.js').then((module) => module.automation),
    forms: () => import('./locales/tg/forms.js').then((module) => module.forms),
    alerts: () => import('./locales/tg/alerts.js').then((module) => module.alerts),
    schedules: () => import('./locales/tg/schedules.js').then((module) => module.schedules),
  },
  en: {
    notifications: () =>
      import('./locales/en/notifications.js').then((module) => module.notifications),
    telegram: () => import('./locales/en/telegram.js').then((module) => module.telegram),
    documents: () => import('./locales/en/documents.js').then((module) => module.documents),
    gis: () => import('./locales/en/gis.js').then((module) => module.gis),
    data: () => import('./locales/en/data.js').then((module) => module.data),
    tasks: () => import('./locales/en/tasks.js').then((module) => module.tasks),
    processes: () => import('./locales/en/processes.js').then((module) => module.processes),
    processDesigner: () =>
      import('./locales/en/processDesigner.js').then((module) => module.processDesigner),
    documentAssist: () =>
      import('./locales/en/documentAssist.js').then((module) => module.documentAssist),
    calendar: () => import('./locales/en/calendar.js').then((module) => module.calendar),
    chats: () => import('./locales/en/chats.js').then((module) => module.chats),
    meetings: () => import('./locales/en/meetings.js').then((module) => module.meetings),
    assistant: () => import('./locales/en/assistant.js').then((module) => module.assistant),
    knowledge: () => import('./locales/en/knowledge.js').then((module) => module.knowledge),
    profile: () => import('./locales/en/profile.js').then((module) => module.profile),
    admin: () => import('./locales/en/admin.js').then((module) => module.admin),
    automation: () => import('./locales/en/automation.js').then((module) => module.automation),
    forms: () => import('./locales/en/forms.js').then((module) => module.forms),
    alerts: () => import('./locales/en/alerts.js').then((module) => module.alerts),
    schedules: () => import('./locales/en/schedules.js').then((module) => module.schedules),
  },
}
