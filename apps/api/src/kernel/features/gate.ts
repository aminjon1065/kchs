import type { FastifyRequest } from 'fastify'
import { errors } from '~/shared/errors.js'
import { featureOfTags } from './registry.js'
import { FeatureService } from './service.js'

/**
 * Шлюз возможностей (15-admin-operations.md §1): запрос к выключенной
 * возможности получает «не найдено», а не «нет доступа» — выключенного модуля
 * для пользователя просто нет. Администрирование не выключается: иначе
 * возможность некому было бы вернуть.
 */
export async function featureGate(request: FastifyRequest): Promise<void> {
  const key = featureOfTags(request.routeOptions?.config?.apiTags)
  if (!key) return
  if (await FeatureService.enabled(key)) return
  throw errors.notFound('Возможность', { feature: key })
}
