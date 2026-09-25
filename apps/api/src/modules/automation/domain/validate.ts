import {
  domainAllowed,
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
import { SecurityPolicyService } from '~/kernel/settings/security-policy.js'
import { conditionExpressions, templateExpressions } from './scope.js'

/**
 * Проверка определения правила (ADR-0096): форму проверяет zod, здесь —
 * смысл: известен ли тип события, разбирается ли выражение и по допустимым
 * ли корням, разбираются ли выражения назначений, верно ли расписание.
 * Ошибки не дают сохранить правило; предупреждения — подсказки конструктору.
 */

const DOMAINS = new Set(EVENT_TYPES.map((type) => type.split('.')[0] ?? ''))

/**
 * Белый список адресатов правил (N38, ADR-0141): явные адреса писем — только этих доменов,
 * вебхуки — только на эти домены. Ведёт администратор в политике безопасности.
 */
export interface RuleAllowlist {
  emailDomains: readonly string[]
  webhookDomains: readonly string[]
}

export async function ruleAllowlist(): Promise<RuleAllowlist> {
  const policy = await SecurityPolicyService.current()
  return { emailDomains: policy.ruleEmailDomains, webhookDomains: policy.ruleWebhookDomains }
}

const WHERE_LIST = 'список ведёт администратор: «Администрирование» → «Безопасность»'

/** Явный адрес почты, а не выражение назначения (как у `send_email`). */
const isPlainEmail = (source: string) =>
  source.includes('@') && !source.includes('(') && !source.includes(':') && !source.includes('{{')

export function emailOutsideAllowlist(address: string, allow: RuleAllowlist): string | null {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return domainAllowed(domain, allow.emailDomains)
    ? null
    : `Адрес «${address}» вне организации: домена «${domain}» нет в белом списке писем правил — ${WHERE_LIST}`
}

export function webhookOutsideAllowlist(url: string, allow: RuleAllowlist): string | null {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  return domainAllowed(host, allow.webhookDomains)
    ? null
    : `Домена «${host}» нет в списке разрешённых для вебхуков правил — ${WHERE_LIST}`
}

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
    // Назначение может собираться шаблоном (`user:{{object.id}}`): исполнение
    // подставляет значения до разбора, поэтому здесь проверяются только
    // выражения шаблона, а само назначение — при запуске
    if (source.includes('{{')) {
      this.template(path, source)
      return
    }
    const { problem } = checkAssignee(source, { variables: {} })
    if (problem) this.error(path, problem.message)
  }

  /** Ссылка на объект: идентификатор или шаблон, который его даст при запуске. */
  objectRef(path: string, source: string): void {
    const value = source.trim()
    if (value.includes('{{')) return
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      this.error(path, 'Нужен идентификатор объекта или шаблон {{…}}, который его даст')
    }
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

function checkAction(
  issues: Issues,
  action: RuleAction,
  index: number,
  allow: RuleAllowlist | undefined,
  branch: 'actions' | 'otherwise' = 'actions',
): void {
  const at = `${branch}.${index}`
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
      for (const [i, to] of action.to.entries()) {
        issues.assignee(`${at}.to.${i}`, to)
        const outside = allow && isPlainEmail(to) ? emailOutsideAllowlist(to.trim(), allow) : null
        if (outside) issues.error(`${at}.to.${i}`, outside)
      }
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
      {
        const outside = allow ? webhookOutsideAllowlist(action.url, allow) : null
        if (outside) issues.error(`${at}.url`, outside)
      }
      break
    case 'ai_task':
      issues.template(`${at}.prompt`, action.prompt)
      issues.template(`${at}.object`, action.object)
      break
    case 'run_pipeline':
      issues.template(`${at}.pipelineId`, action.pipelineId)
      issues.objectRef(`${at}.pipelineId`, action.pipelineId)
      break
    case 'run_import':
      issues.template(`${at}.sourceId`, action.sourceId)
      issues.objectRef(`${at}.sourceId`, action.sourceId)
      break
    case 'stop':
      if (action.when) issues.expression(`${at}.when`, action.when)
      break
    default:
      break
  }
}

/**
 * Смысловая проверка правила: ошибки и предупреждения с путями в определении. С белым
 * списком адресатов проверяются и письма на явные адреса, и вебхуки (ADR-0141); без него —
 * только форма и выражения.
 */
export function checkRule(definition: RuleDefinition, allow?: RuleAllowlist): RuleIssue[] {
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

  for (const [index, action] of definition.actions.entries()) {
    checkAction(issues, action, index, allow)
  }
  // Ветка «иначе» (ADR-0163): те же проверки, пути — `otherwise.N`
  for (const [index, action] of definition.otherwise.entries()) {
    checkAction(issues, action, index, allow, 'otherwise')
  }
  if (definition.otherwise.length > 0 && !definition.conditions) {
    issues.warning('otherwise', 'Без условий ветка «иначе» не выполнится никогда')
  }
  issues.template('limits.dedupeKey', definition.limits.dedupeKey)

  if (!definition.runAs) {
    issues.error('runAs', 'Укажите служебного пользователя: от его имени работает правило')
  }
  for (const branch of ['actions', 'otherwise'] as const) {
    if (definition[branch].at(-1)?.type === 'wait') {
      issues.warning(branch, 'Ожидание последним действием ничего не даёт')
    }
  }
  return issues.list
}

export function ruleIssuesOk(issues: RuleIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error')
}

/**
 * Черновик правила сохраняется и без служебного пользователя: правило
 * рождается выключенным, а включить его без `runAs` всё равно нельзя
 * (`setEnabled`). Остальные ошибки держат сохранение как раньше.
 */
export function blockingIssues(issues: RuleIssue[], enabled: boolean): RuleIssue[] {
  const errors = issues.filter((issue) => issue.severity === 'error')
  return enabled ? errors : errors.filter((issue) => issue.path !== 'runAs')
}
