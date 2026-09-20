/**
 * Единый планировщик платформы (14-automation-integrations.md §2, ADR-0096):
 * регулярные задания объявляются через `declareSchedule`, приводятся к
 * состоянию в BullMQ одним вызовом `syncSchedules()` при старте воркера и
 * видны администратору на экране «Расписания».
 */
export { registerScheduleRoutes } from './http.js'
export {
  clearSchedules,
  declareSchedule,
  listSchedules,
  type ScheduleDefinition,
  scheduleDefinition,
  scheduleKey,
} from './registry.js'
export {
  nextRunAt,
  nextRuns,
  type RuleScheduleEntry,
  type RuleScheduleProvider,
  ScheduleService,
  setRuleScheduleProvider,
  syncSchedules,
} from './service.js'
