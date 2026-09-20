import {
  ScheduleEnabledInput,
  ScheduleList,
  ScheduleRecord,
  ScheduleRunList,
  ScheduleRunsQuery,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ScheduleService } from './service.js'

const KeyParam = z.object({ key: z.string().min(1).max(200) })

/**
 * Экран «Расписания» в администрировании (14-automation-integrations.md §2):
 * регулярные задания платформы и правила по cron — ближайший запуск, история,
 * включение и выключение. Право — `automation.manage`.
 */
export function registerScheduleRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/schedules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Расписания платформы и правил: ближайшие запуски и последний результат',
    schema: { response: { 200: ScheduleList } },
    handler: async () => ({ items: await ScheduleService.list() }),
  })

  route({
    method: 'POST',
    url: '/schedules/:key/enabled',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Включить или выключить расписание',
    schema: { params: KeyParam, body: ScheduleEnabledInput, response: { 200: ScheduleRecord } },
    handler: async (request) =>
      ScheduleService.setEnabled(request.ctx, request.params.key, request.body.enabled),
  })

  route({
    method: 'POST',
    url: '/schedules/:key/run',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Выполнить задание расписания сейчас',
    schema: { params: KeyParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await ScheduleService.runNow(request.ctx, request.params.key)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/schedules/:key/runs',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'История запусков системного задания',
    schema: {
      params: KeyParam,
      querystring: ScheduleRunsQuery,
      response: { 200: ScheduleRunList },
    },
    handler: async (request) => ({
      items: await ScheduleService.runs(request.params.key, request.query.limit),
    }),
  })
}
