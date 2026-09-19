import type { FastifyInstance } from 'fastify'
import { setDirectoryProvider } from '~/kernel/directory/port.js'
import { registerKernelObjectTypes } from '~/kernel/object-types.js'
import { listObjectTypes } from '~/kernel/objects/registry.js'
import { registerProcessEngine } from '~/kernel/process/index.js'
import { registerKernelRoutes } from '~/kernel/routes.js'
import { setSecondFactorProvider } from '~/kernel/second-factor/port.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerAdminRoutes } from './admin/module.js'
import { registerAiRoutes } from './ai/module.js'
import {
  registerDataBackground,
  registerDataObjectTypes,
  registerDataRoutes,
  upgradeDataStorage,
} from './data/module.js'
import {
  registerDocumentsBackground,
  registerDocumentsObjectTypes,
  registerDocumentsRoutes,
} from './documents/module.js'
import {
  registerFilesBackground,
  registerFilesObjectTypes,
  registerFilesRoutes,
  scheduleFilesJobs,
} from './files/module.js'
import { registerGisBackground, registerGisObjectTypes, registerGisRoutes } from './gis/module.js'
import { registerIdentityBackground, registerIdentityRoutes } from './identity/module.js'
import { AuthService, DirectoryQueries, OrgService, UserService } from './identity/public.js'
import {
  registerReportsBackground,
  registerReportsObjectTypes,
  registerReportsRoutes,
  scheduleReportsJobs,
} from './reports/module.js'
import {
  registerTasksBackground,
  registerTasksObjectTypes,
  registerTasksRoutes,
  scheduleTasksJobs,
} from './tasks/module.js'
import {
  registerTelegramChannel,
  registerTelegramRoutes,
  startTelegramPolling,
  stopTelegramPolling,
} from './telegram/module.js'

/** Хранилища модулей, которые создаются на лету (таблицы датасетов), — к текущему виду. */
export async function upgradeModuleStorage(): Promise<void> {
  await upgradeDataStorage()
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
  registerFilesObjectTypes()
  registerDataObjectTypes()
  registerGisObjectTypes()
  registerReportsObjectTypes()
  registerTasksObjectTypes()
  registerDocumentsObjectTypes()
  registerDirectory()
  // Каналы уведомлений модулей: ядро доставляет через них в любой роли процесса
  registerTelegramChannel()
}

/** Модуль identity предоставляет ядру справочник людей и оргструктуры и проверку второго фактора. */
function registerDirectory(): void {
  setDirectoryProvider({
    refs: (userIds, database) => UserService.refs(userIds, database),
    displayName: async (userId) => {
      const refs = await UserService.refs([userId])
      return refs.get(userId)?.displayName ?? 'Система'
    },
    manager: (userId) => OrgService.manager(userId),
    subordinates: (userId) => OrgService.subordinates(userId),
    unitHead: (unitId) => OrgService.unitHead(unitId),
    primaryUnit: (userId) => DirectoryQueries.primaryUnit(userId),
    unitMembers: (unitId) => DirectoryQueries.unitMembers(unitId),
    unitByCode: (code) => DirectoryQueries.unitByCode(code),
    groupMembers: (groupId) => DirectoryQueries.groupMembers(groupId),
    usersWithRole: (roleKey, options) => DirectoryQueries.usersWithRole(roleKey, options),
    activeUsers: (userIds) => DirectoryQueries.activeUsers(userIds),
  })
  // Подтверждение подписи вторым фактором (ADR-0079): только TOTP, без резервных кодов
  setSecondFactorProvider({
    enrolled: (userId) => AuthService.mfaEnabled(userId),
    verify: (userId, code) => AuthService.verifyTotp(userId, code),
  })
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
  registerTelegramRoutes(route)
  registerAiRoutes(route)
  registerAdminRoutes(route)
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
}

export async function scheduleModuleJobs(): Promise<void> {
  await scheduleFilesJobs()
  await scheduleReportsJobs()
  await scheduleTasksJobs()
}

/** Долгоживущие процессы модулей в роли worker: опрос Telegram-бота (ADR-0061). */
export function startModuleServices(): void {
  startTelegramPolling()
}

export async function stopModuleServices(): Promise<void> {
  await stopTelegramPolling()
}
