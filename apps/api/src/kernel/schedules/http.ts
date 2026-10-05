import type { RouteRegistrar } from '~/shared/http/route.js'
import { ScheduleService } from './service.js'

/**
 * Экран «Расписания» в администрировании (14-automation-integrations.md §2):
 * регулярные задания платформы и правила по cron — ближайший запуск, история,
 * включение и выключение. Право — `automation.manage`.
 */
export function registerScheduleRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /schedules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Расписания платформы и правил: ближайшие запуски и последний результат',
    handler: async () => ({ items: await ScheduleService.list() }),
  })

  route({
    route: 'POST /schedules/:key/enabled',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Включить или выключить расписание',
    handler: async (request) =>
      ScheduleService.setEnabled(request.ctx, request.params.key, request.body.enabled),
  })

  route({
    route: 'POST /schedules/:key/run',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Выполнить задание расписания сейчас',
    handler: async (request) => {
      await ScheduleService.runNow(request.ctx, request.params.key)
      return { ok: true }
    },
  })

  route({
    route: 'GET /schedules/:key/runs',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'История запусков системного задания',
    handler: async (request) => ({
      items: await ScheduleService.runs(request.params.key, request.query.limit),
    }),
  })
}
