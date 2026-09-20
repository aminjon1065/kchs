import {
  EVENT_TYPES,
  isKnownEventType,
  RULE_EXPRESSION_ROOTS,
  type RuleAction,
  type RuleDefinition,
  type RuleIssue,
} from '@kchs/contracts'
import { checkAssignee } from '@kchs/process'
import { checkEvaluable } from '@kchs/query/expr'
import cronParser from 'cron-parser'
import { conditionExpressions, templateExpressions } from './scope.js'

/**
 * Проверка определения правила (ADR-0096): форму проверяет zod, здесь —
 * смысл: известен ли тип события, разбирается ли выражение и по допустимым
 * ли корням, разбираются ли выражения назначений, верно ли расписание.
 * Ошибки не дают сохранить правило; предупреждения — подсказки конструктору.
 */

const DOMAINS = new Set(EVENT_TYPES.map((type) => type.split('.')[0] ?? ''))

/** Область вычисления условия триггера по показателю. */
const METRIC_ROOTS = ['value', 'previous', 'metric', 'now']

function validTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

class Issues {
  readonly list: RuleIssue[] = []

  error(path: string, message: string): void {
    this.list.push({ path, message, severity: 'error' })
  }

  warning(path: string, message: string): void {
    this.list.push({ path, message, severity: 'warning' })
  }

  /** Выражение: разбирается и ссылается на допустимые корни. */
  expression(path: string, source: string, roots: readonly string[] = RULE_EXPRESSION_ROOTS): void {
    const problem = checkEvaluable(source, roots)
    if (problem) this.error(path, problem.message)
  }

  /** Шаблон `{{…}}`: каждое выражение внутри проверяется отдельно. */
  template(path: string, source: string | null | undefined): void {
    if (!source) return
    for (const expression of templateExpressions(source)) this.expression(path, expression)
  }

  assignee(path: string, source: string): void {
    // Явный адрес почты — не выражение назначения (действие send_email)
    if (source.includes('@') && !source.includes('(') && !source.includes(':')) return
    const { problem } = checkAssignee(source, { variables: {} })
    if (problem) this.error(path, problem.message)
  }

  cron(path: string, pattern: string, timezone: string): void {
    if (!validTimezone(timezone)) {
      this.error(path, 'Неизвестный часовой пояс')
      return
    }
    try {
      cronParser.parseExpression(pattern, { tz: timezone }).next()
    } catch {
      this.error(path, 'Неверное выражение cron')
    }
  }
}

function checkAction(issues: Issues, action: RuleAction, index: number): void {
  const at = `actions.${index}`
  switch (action.type) {
    case 'notify':
      for (const [i, to] of action.to.entries()) issues.assignee(`${at}.to.${i}`, to)
      issues.template(`${at}.text`, action.text)
      issues.template(`${at}.object`, action.object)
      break
    case 'create_task':
      issues.assignee(`${at}.assignee`, action.assignee)
      for (const [i, to] of action.coAssignees.entries()) {
        issues.assignee(`${at}.coAssignees.${i}`, to)
      }
      if (action.controller) issues.assignee(`${at}.controller`, action.controller)
      issues.template(`${at}.title`, action.title)
      issues.template(`${at}.description`, action.description)
      issues.template(`${at}.dueAt`, action.dueAt)
      issues.template(`${at}.source`, action.source)
      if (!action.dueAt && !action.dueWorkingDays) {
        issues.error(`${at}.dueWorkingDays`, 'Укажите срок: дату или число рабочих дней')
      }
      break
    case 'update_fields':
      if (Object.keys(action.fields).length === 0) {
        issues.error(`${at}.fields`, 'Укажите хотя бы одно поле')
      }
      for (const [key, value] of Object.entries(action.fields)) {
        issues.template(`${at}.fields.${key}`, value)
      }
      issues.template(`${at}.object`, action.object)
      break
    case 'set_status':
      issues.template(`${at}.comment`, action.comment)
      issues.template(`${at}.object`, action.object)
      break
    case 'assign':
      issues.assignee(`${at}.assignee`, action.assignee)
      issues.template(`${at}.object`, action.object)
      break
    case 'create_document':
      issues.template(`${at}.subject`, action.subject)
      for (const [key, value] of Object.entries(action.fields)) {
        issues.template(`${at}.fields.${key}`, value)
      }
      break
    case 'start_process':
      for (const [key, value] of Object.entries(action.variables)) {
        issues.template(`${at}.variables.${key}`, value)
      }
      issues.template(`${at}.object`, action.object)
      break
    case 'add_link':
      issues.template(`${at}.target`, action.target)
      issues.template(`${at}.object`, action.object)
      break
    case 'add_tag':
      issues.template(`${at}.tag`, action.tag)
      issues.template(`${at}.object`, action.object)
      break
    case 'post_message':
      issues.template(`${at}.text`, action.text)
      issues.template(`${at}.conversation`, action.conversation)
      break
    case 'create_event':
      issues.template(`${at}.title`, action.title)
      issues.template(`${at}.startsAt`, action.startsAt)
      for (const [i, to] of action.participants.entries()) {
        issues.assignee(`${at}.participants.${i}`, to)
      }
      break
    case 'send_email':
      for (const [i, to] of action.to.entries()) issues.assignee(`${at}.to.${i}`, to)
      issues.template(`${at}.subject`, action.subject)
      issues.template(`${at}.body`, action.body)
      break
    case 'send_telegram':
      for (const [i, to] of action.to.entries()) issues.assignee(`${at}.to.${i}`, to)
      issues.template(`${at}.text`, action.text)
      issues.template(`${at}.object`, action.object)
      break
    case 'webhook':
      for (const [key, value] of Object.entries(action.payload)) {
        issues.template(`${at}.payload.${key}`, value)
      }
      for (const [key, value] of Object.entries(action.headers)) {
        issues.template(`${at}.headers.${key}`, value)
      }
      if (!action.url.startsWith('https://') && !action.url.startsWith('http://')) {
        issues.error(`${at}.url`, 'Адрес вызова — http или https')
      }
      if (action.url.startsWith('http://')) {
        issues.warning(`${at}.url`, 'Вызов без шифрования: данные уйдут открытым текстом')
      }
      break
    case 'ai_task':
      issues.template(`${at}.prompt`, action.prompt)
      issues.template(`${at}.object`, action.object)
      break
    case 'stop':
      if (action.when) issues.expression(`${at}.when`, action.when)
      break
    default:
      break
  }
}

/** Смысловая проверка правила: ошибки и предупреждения с путями в определении. */
export function checkRule(definition: RuleDefinition): RuleIssue[] {
  const issues = new Issues()
  const trigger = definition.trigger

  switch (trigger.kind) {
    case 'event': {
      const domain = trigger.type.split('.')[0] ?? ''
      const wildcard = trigger.type.endsWith('.*')
      if (wildcard ? !DOMAINS.has(domain) : !isKnownEventType(trigger.type)) {
        issues.error('trigger.type', `Событие «${trigger.type}» не описано в каталоге событий`)
      }
      if (wildcard && !definition.conditions) {
        issues.warning(
          'trigger.type',
          'Правило сработает на каждое событие домена: добавьте условие',
        )
      }
      break
    }
    case 'schedule':
      issues.cron('trigger.cron', trigger.cron, trigger.timezone)
      break
    case 'metric':
      issues.cron('trigger.cron', trigger.cron, trigger.timezone)
      issues.expression('trigger.condition', trigger.condition, METRIC_ROOTS)
      break
    default:
      break
  }

  if (definition.conditions) {
    for (const [index, expression] of conditionExpressions(definition.conditions).entries()) {
      issues.expression(`conditions.${index}`, expression)
    }
  }

  for (const [index, action] of definition.actions.entries()) checkAction(issues, action, index)
  issues.template('limits.dedupeKey', definition.limits.dedupeKey)

  if (!definition.runAs) {
    issues.error('runAs', 'Укажите служебного пользователя: от его имени работает правило')
  }
  if (definition.actions.some((action) => action.type === 'wait')) {
    const last = definition.actions.at(-1)
    if (last?.type === 'wait') {
      issues.warning('actions', 'Ожидание последним действием ничего не даёт')
    }
  }
  return issues.list
}

export function ruleIssuesOk(issues: RuleIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error')
}
