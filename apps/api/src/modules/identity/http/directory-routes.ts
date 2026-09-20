import {
  DirectorySettingsInput,
  DirectoryState,
  DirectorySyncRun,
  DirectoryTestResult,
} from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { roles } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthProviders, LDAP_PROVIDER } from '../domain/auth-providers.js'
import { DirectorySync } from '../domain/directory-sync.js'

/**
 * Каталог LDAP/AD в администрировании (ADR-0098). Пароль учётной записи чтения
 * принимается только на запись: наружу уходит признак «пароль задан».
 */
export function registerDirectoryRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/admin/directory',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Настройка каталога LDAP/AD',
    schema: { response: { 200: DirectoryState } },
    handler: async () => {
      const [{ enabled, settings, bindPassword, updatedAt }, lastRun] = await Promise.all([
        AuthProviders.directory(),
        DirectorySync.lastRun(),
      ])
      return {
        ...settings,
        enabled,
        hasBindPassword: bindPassword !== null,
        updatedAt,
        lastRun,
      }
    },
  })

  route({
    method: 'PUT',
    url: '/admin/directory',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Изменить настройку каталога',
    schema: { body: DirectorySettingsInput, response: { 200: DirectoryState } },
    handler: async (request) => {
      const input = request.body
      await assertRolesExist([
        ...input.defaultRoleKeys,
        ...input.groupMappings.map((mapping) => mapping.roleKey),
      ])
      if (input.enabled && (!input.url || !input.baseDn)) {
        throw errors.validation('Для включения нужны адрес каталога и корень поиска', [
          { path: 'url', message: 'Заполните адрес каталога и корень поиска' },
        ])
      }
      await db().transaction((tx) => AuthProviders.saveDirectory(tx, request.ctx, input))
      // Кэш процесса — после коммита: иначе параллельный вход возьмёт старые настройки
      AuthProviders.invalidate(LDAP_PROVIDER)

      const { enabled, settings, bindPassword, updatedAt } = await AuthProviders.directory()
      const lastRun = await DirectorySync.lastRun()
      return { ...settings, enabled, hasBindPassword: bindPassword !== null, updatedAt, lastRun }
    },
  })

  route({
    method: 'POST',
    url: '/admin/directory/test',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Проверить соединение с каталогом',
    rateLimit: rateLimit(10, '1 minute'),
    schema: { response: { 200: DirectoryTestResult } },
    handler: async () => DirectorySync.test(),
  })

  route({
    method: 'POST',
    url: '/admin/directory/preview',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Предпросмотр: что изменится при синхронизации',
    rateLimit: rateLimit(5, '1 minute'),
    schema: { response: { 200: DirectorySyncRun } },
    handler: async (request) => DirectorySync.preview(request.ctx),
  })

  route({
    method: 'POST',
    url: '/admin/directory/sync',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Синхронизировать каталог сейчас',
    rateLimit: rateLimit(5, '1 minute'),
    schema: { response: { 200: DirectorySyncRun } },
    handler: async (request) => DirectorySync.run(request.ctx, 'manual'),
  })

  route({
    method: 'GET',
    url: '/admin/directory/syncs',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Журнал синхронизаций каталога',
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
      response: { 200: z.object({ items: z.array(DirectorySyncRun) }) },
    },
    handler: async (request) => ({ items: await DirectorySync.history(request.query.limit) }),
  })
}

/** Сопоставление на несуществующую роль — ошибка настройки, а не тихий пропуск. */
async function assertRolesExist(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)].filter(Boolean)
  if (unique.length === 0) return
  const found = await db().select({ key: roles.key }).from(roles).where(inArray(roles.key, unique))
  const missing = unique.filter((key) => !found.some((row) => row.key === key))
  if (missing.length > 0) {
    throw errors.validation('Неизвестные роли', [
      { path: 'groupMappings', message: missing.join(', '), code: 'unknown_role' },
    ])
  }
}
