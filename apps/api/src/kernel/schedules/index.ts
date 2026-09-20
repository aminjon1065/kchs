/**
 * Единый планировщик платформы (14-automation-integrations.md §2, ADR-0096):
 * регулярные задания объявляются через `declareSchedule`, приводятся к
 * состоянию в BullMQ одним вызовом `syncSchedules()` при старте воркера и
 * видны администратору на экране «Расписания».
 */
export { registerScheduleRoutes } from './http.js'
export {
  declareSchedule,
  listSchedules,
  type ScheduleDefinition,
  scheduleDefinition,
  scheduleKey,
} from './registry.js'
export {
  type EntityScheduleEntry,
  type EntityScheduleProvider,
  nextRunAt,
  nextRuns,
  registerEntityScheduleProvider,
  ScheduleService,
  syncSchedules,
} from './service.js'
