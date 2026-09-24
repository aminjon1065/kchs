/**
 * @kchs/process — движок процессов без базы (ADR-0012, ADR-0079): контракт
 * ProcessDefinition, проверка определений, выражения назначений и их резолвер
 * против порта справочника, модель состояния экземпляра и переходов, контракты
 * HTTP API. Исполнение (хранение, Входящие, таймеры, события) — в ядре api.
 */
export * from './api.js'
export {
  type AssigneeCheckContext,
  type AssigneeExpr,
  AssigneeSyntaxError,
  assigneeNodes,
  assigneeSort,
  checkAssignee,
  formatAssignee,
  parseAssignee,
} from './assignee.js'
export { hoursDeadline, hoursReminder } from './deadline.js'
export {
  applyConditions,
  type BranchPlace,
  branchPlaces,
  conditionKey,
  descendantsOf,
  topLevelEdges,
} from './graph.js'
export {
  type AvailableActions,
  addStepAssignee,
  assignStep,
  availableActions,
  cancelProcess,
  completeStep,
  DECISIONS,
  DECISIONS_BY_TYPE,
  type Decision,
  decideStep,
  delegateStep,
  type EntryState,
  type InstanceState,
  initialState,
  type MachineEnv,
  outcomeOf,
  ProcessError,
  type ProcessErrorCode,
  previousAssignees,
  reassignStep,
  type StepEntry,
  type StepRun,
  type StepStatus,
  type StepsScope,
  startProcess,
  stepsScope,
  type Transition,
  type Work,
} from './machine.js'
export {
  type AssigneeDirectory,
  type ResolveContext,
  type ResolvedAssignee,
  type ResolveIssue,
  type ResolveIssueCode,
  type ResolveResult,
  resolveAssignees,
} from './resolve.js'
export * from './schema.js'
export {
  CONDITION_ROOTS,
  checkDefinition,
  parseUntil,
  type ValidationResult,
  validateDefinition,
} from './validate.js'
