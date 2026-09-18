import type { FastifyInstance } from 'fastify'
import { setDirectoryProvider } from '~/kernel/directory/port.js'
import { registerKernelObjectTypes } from '~/kernel/object-types.js'
import { listObjectTypes } from '~/kernel/objects/registry.js'
import { registerKernelRoutes } from '~/kernel/routes.js'
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
  registerFilesBackground,
  registerFilesObjectTypes,
  registerFilesRoutes,
  scheduleFilesJobs,
} from './files/module.js'
import { registerGisObjectTypes, registerGisRoutes } from './gis/module.js'
import { registerIdentityBackground, registerIdentityRoutes } from './identity/module.js'
import { OrgService, UserService } from './identity/public.js'
import {
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
  registerFilesObjectTypes()
  registerDataObjectTypes()
  registerGisObjectTypes()
  registerTasksObjectTypes()
  registerDirectory()
  // Каналы уведомлений модулей: ядро доставляет через них в любой роли процесса
  registerTelegramChannel()
}

/** Модуль identity предоставляет ядру справочник людей и оргструктуры. */
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
  })
}

export async function registerModules(app: FastifyInstance, route: RouteRegistrar): Promise<void> {
  registerKernelRoutes(route)
  registerIdentityRoutes(route)
  registerFilesRoutes(route)
  registerDataRoutes(route)
  registerGisRoutes(route)
  registerTasksRoutes(route)
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
  registerTasksBackground()
}

export async function scheduleModuleJobs(): Promise<void> {
  await scheduleFilesJobs()
}

/** Долгоживущие процессы модулей в роли worker: опрос Telegram-бота (ADR-0061). */
export function startModuleServices(): void {
  startTelegramPolling()
}

export async function stopModuleServices(): Promise<void> {
  await stopTelegramPolling()
}
