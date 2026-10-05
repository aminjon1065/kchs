import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { PassportService } from '../domain/passport-service.js'

/**
 * Паспорт территории (ADR-0077): сводка данных, показателей и поручений по единице
 * справочника. Справочник — модуль `territories` (ADR-0180); паспорт опирается на
 * датасеты, слои и задачи, поэтому живёт в GIS — слоем выше справочника.
 */
export function registerPassportRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /gis/territories/:id/passport',
    auth: { delegated: 'PassportService.get → TerritoryService.get', objectType: 'territory' },
    tags: ['gis'],
    summary: 'Паспорт территории: показатели датасетов, привязанные показатели, поручения',
    description:
      'Строки и суммы мер датасетов с полем территории (с вложенными единицами) за период и предыдущий период, по месяцам и по дочерним единицам; показатели со связью about_territory; задачи с территорией — всё с правами и политиками смотрящего (ADR-0077).',
    handler: async (request) => {
      if (request.ctx.shareLink) throw errors.forbidden()
      return PassportService.get(request.ctx, request.params.id, request.query.period)
    },
  })
}
