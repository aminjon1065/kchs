import type { FastifyInstance } from 'fastify'
import { registerAcknowledgments } from '~/kernel/acknowledgments/index.js'
import { setCredentialsProvider } from '~/kernel/directory/credentials.js'
import { registerDirectoryProvider } from '~/kernel/directory/provider.js'
import { setTerritoryLookup } from '~/kernel/directory/territory-lookup.js'
import { registerKernelObjectTypes } from '~/kernel/object-types.js'
import { listObjectTypes } from '~/kernel/objects/registry.js'
import { registerProcessEngine } from '~/kernel/process/index.js'
import { registerKernelRoutes } from '~/kernel/routes.js'
import { setSecondFactorProvider } from '~/kernel/second-factor/port.js'
import { ADVISORY_LOCKS, withAdvisoryLock } from '~/shared/db/advisory.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerAdminRoutes } from './admin/module.js'
import { registerAiFeature, registerAiRoutes } from './ai/module.js'
import {
  declareAlertSchedules,
  registerAlertObjectTypes,
  registerAlertRoutes,
  registerAlertsBackground,
} from './alerts/module.js'
import {
  declareAutomationSchedules,
  registerAutomationBackground,
  registerAutomationObjectTypes,
  registerAutomationRoutes,
  scheduleAutomationJobs,
} from './automation/module.js'
import {
  declareCalendarSchedules,
  registerCalendarBackground,
  registerCalendarObjectTypes,
  registerCalendarRoutes,
  scheduleCalendarJobs,
} from './calendar/module.js'
import {
  registerChatBackground,
  registerChatFeature,
  registerChatQuietHours,
  registerChatRoutes,
  scheduleChatJobs,
} from './chat/module.js'
import {
  declareDataSchedules,
  registerDataBackground,
  registerDataObjectTypes,
  registerDataRoutes,
  scheduleDataJobs,
  upgradeDataStorage,
} from './data/module.js'
import {
  declareDocumentsSchedules,
  registerDocumentsBackground,
  registerDocumentsObjectTypes,
  registerDocumentsRoutes,
} from './documents/module.js'
import {
  declareFilesSchedules,
  registerFilesBackground,
  registerFilesObjectTypes,
  registerFilesPages,
  registerFilesRoutes,
} from './files/module.js'
import {
  declareFormsSchedules,
  registerFormObjectTypes,
  registerFormRoutes,
  registerFormsBackground,
} from './forms/module.js'
import { registerGisBackground, registerGisObjectTypes, registerGisRoutes } from './gis/module.js'
import { territoryIndex } from './gis/public.js'
import {
  declareIdentitySchedules,
  registerIdentityBackground,
  registerIdentityRoutes,
} from './identity/module.js'
import { AuthService } from './identity/public.js'
import {
  declareIntegrationsSchedules,
  registerIntegrationsBackground,
  registerIntegrationsObjectTypes,
  registerIntegrationsRoutes,
  scheduleIntegrationsJobs,
} from './integrations/module.js'
import {
  declareKnowledgeSchedules,
  registerKnowledgeBackground,
  registerKnowledgeObjectTypes,
  registerKnowledgeRoutes,
  scheduleKnowledgeJobs,
} from './knowledge/module.js'
import { connectKnowledgeSemantics } from './knowledge/semantic-source.js'
import {
  registerMailBackground,
  registerMailFeature,
  registerMailModuleRoutes,
} from './mail/module.js'
import {
  declareMeetingsSchedules,
  registerMeetingsBackground,
  registerMeetingsObjectTypes,
  registerMeetingsRoutes,
} from './meetings/module.js'
import { registerPushChannel, registerPushRoutes } from './push/module.js'
import {
  registerReportsBackground,
  registerReportsObjectTypes,
  registerReportsRoutes,
  scheduleReportsJobs,
} from './reports/module.js'
import {
  declareTasksSchedules,
  registerTasksBackground,
  registerTasksObjectTypes,
  registerTasksRoutes,
} from './tasks/module.js'
import {
  registerTelegramChannel,
  registerTelegramRoutes,
  startTelegramPolling,
  stopTelegramPolling,
} from './telegram/module.js'

/** Хранилища модулей, которые создаются на лету (таблицы датасетов), — к текущему виду. */
/**
 * Таблицы модулей, созданные прежними версиями, — к текущему виду при старте. Под
 * блокировкой: реплики, стартующие вместе, иначе перестраивали бы одни и те же
 * индексы наперегонки, и вторая падала бы на уже удалённом (ADR-0173).
 */
export async function upgradeModuleStorage(): Promise<void> {
  await withAdvisoryLock(ADVISORY_LOCKS.storageUpgrade, () => upgradeDataStorage())
}

/**
 * Типы объектов регистрируются до старта HTTP — ядро узнаёт о них отсюда.
 * Идемпотентно: повторный вызов (тесты, перезапуск) ничего не меняет.
 */
export function registerAllObjectTypes(): void {
  if (listObjectTypes().length > 0) return
  registerKernelObjectTypes()
  // Движок процессов: действия шагов во Входящих — в любой роли процесса
  registerProcessEngine()
  // Ознакомление (ADR-0084): дела «Ознакомиться» и учёт шагов маршрута
  registerAcknowledgments()
  registerFilesObjectTypes()
  registerDataObjectTypes()
  registerGisObjectTypes()
  registerReportsObjectTypes()
  registerTasksObjectTypes()
  registerDocumentsObjectTypes()
  registerCalendarObjectTypes()
  registerMeetingsObjectTypes()
  registerKnowledgeObjectTypes()
  // Возможности модулей без своих типов объектов (15-admin-operations.md §1)
  registerChatFeature()
  registerAiFeature()
  connectKnowledgeSemantics()
  registerIntegrationsObjectTypes()
  // Правила автоматизации (ADR-0096): тип `rule` — объект реестра
  registerAutomationObjectTypes()
  // Формы сбора данных (ADR-0103) и алерты на показатели (ADR-0104)
  registerFormObjectTypes()
  registerAlertObjectTypes()
  registerMailFeature()
  registerDirectory()
  // Каналы уведомлений модулей: ядро доставляет через них в любой роли процесса
  registerTelegramChannel()
  registerPushChannel()
  // Тишина получателя — из присутствия модуля чатов (ADR-0140)
  registerChatQuietHours()
}

/**
 * Справочник людей и оргструктуры — в ядре (ADR-0179); модуль identity даёт ему
 * учётные данные и второй фактор, модуль территорий — проверку территории.
 */
function registerDirectory(): void {
  registerDirectoryProvider()
  setCredentialsProvider({
    setPassword: (userId, password, login, tx) =>
      AuthService.setPassword(userId, password, login, tx),
    revokeSessions: async (userId, tx) => {
      await AuthService.revokeAllExcept(userId, null, tx)
    },
  })
  // Подтверждение подписи вторым фактором (ADR-0079): только TOTP, без резервных кодов
  setSecondFactorProvider({
    enrolled: (userId) => AuthService.mfaEnabled(userId),
    totpEnrolled: (userIds) => AuthService.totpEnrolled(userIds),
    verify: (userId, code) => AuthService.verifyTotp(userId, code),
  })
  setTerritoryLookup({ exists: async (id) => (await territoryIndex()).byId.has(id) })
}

export async function registerModules(app: FastifyInstance, route: RouteRegistrar): Promise<void> {
  registerKernelRoutes(route)
  registerIdentityRoutes(route)
  registerFilesRoutes(route)
  registerDataRoutes(route)
  registerGisRoutes(route)
  registerReportsRoutes(route)
  registerTasksRoutes(route)
  registerDocumentsRoutes(route)
  registerCalendarRoutes(route)
  registerMeetingsRoutes(route)
  registerKnowledgeRoutes(route)
  registerPushRoutes(route)
  registerMailModuleRoutes(route)
  registerChatRoutes(route)
  registerTelegramRoutes(route)
  registerIntegrationsRoutes(route)
  registerAiRoutes(route)
  registerAutomationRoutes(route)
  registerFormRoutes(route)
  registerAlertRoutes(route)
  registerAdminRoutes(route)
  // Страницы модулей вне контракта API: редактор офисных файлов (ADR-0112)
  registerFilesPages(app)
  app.log.debug('модули зарегистрированы')
}

/** Подписчики событий и обработчики заданий модулей — только в роли worker. */
export function registerModulesBackground(): void {
  registerFilesBackground()
  registerIdentityBackground()
  registerDataBackground()
  registerGisBackground()
  registerReportsBackground()
  registerTasksBackground()
  registerDocumentsBackground()
  registerMailBackground()
  registerCalendarBackground()
  registerChatBackground()
  registerMeetingsBackground()
  registerKnowledgeBackground()
  registerIntegrationsBackground()
  registerAutomationBackground()
  registerFormsBackground()
  registerAlertsBackground()
}

/**
 * Расписания модулей объявляются во всех ролях: экран «Расписания» отвечает из
 * api, а в очередь их ставит worker (`syncSchedules`). Здесь — только объявления
 * без обращений к базе и очередям.
 */
export function declareModuleSchedules(): void {
  declareFilesSchedules()
  declareIdentitySchedules()
  declareTasksSchedules()
  declareDocumentsSchedules()
  declareCalendarSchedules()
  declareKnowledgeSchedules()
  declareIntegrationsSchedules()
  declareAutomationSchedules()
  declareFormsSchedules()
  declareMeetingsSchedules()
  declareAlertSchedules()
  declareDataSchedules()
}

/** Работа модулей при старте worker: синхронизация расписаний сущностей, служебные записи. */
export async function scheduleModuleJobs(): Promise<void> {
  await scheduleReportsJobs()
  await scheduleCalendarJobs()
  await scheduleChatJobs()
  await scheduleKnowledgeJobs()
  await scheduleIntegrationsJobs()
  await scheduleAutomationJobs()
  await scheduleDataJobs()
}

/** Долгоживущие процессы модулей в роли worker: опрос Telegram-бота (ADR-0061). */
export function startModuleServices(): void {
  startTelegramPolling()
}

export async function stopModuleServices(): Promise<void> {
  await stopTelegramPolling()
}
