import {
  type AssigneeExpr,
  AssigneeSyntaxError,
  formatAssignee,
  parseAssignee,
} from './assignee.js'
import type { VariableType } from './schema.js'

/**
 * Справочник для резолвера назначений. Реализацию подаёт ядро (порт
 * справочника модуля identity и участники пространств); пакет не знает о базе.
 * Все методы возвращают идентификаторы пользователей или подразделений.
 */
export interface AssigneeDirectory {
  /** Существующие активные пользователи из списка — в том же порядке. */
  activeUsers(userIds: readonly string[]): Promise<string[]>
  groupMembers(groupId: string): Promise<string[]>
  /** Сотрудники подразделения и вложенных подразделений. */
  unitMembers(unitId: string): Promise<string[]>
  unitHead(unitId: string): Promise<string | null>
  /** Руководитель: глава основного подразделения, для самого главы — глава родительского. */
  manager(userId: string): Promise<string | null>
  primaryUnit(userId: string): Promise<string | null>
  unitByCode(code: string): Promise<string | null>
  /** `role:<ключ>` — роль без ограничения и роль, ограниченная пространством объекта. */
  usersWithRole(roleKey: string, spaceId: string | null): Promise<string[]>
  /** `role_in_space:<ключ>` — роль в пространстве объекта (правила — ADR-0079). */
  usersWithRoleInSpace(roleKey: string, spaceId: string | null): Promise<string[]>
}

/** Данные, из которых вычисляются назначения шага. */
export interface ResolveContext {
  authorId: string | null
  /** Подразделение автора, если объект задаёт его сам; иначе — основное подразделение автора. */
  authorUnitId?: string | null
  initiatorId: string | null
  /** Пространство объекта: `role:` и `role_in_space:`. */
  spaceId: string | null
  variables: Readonly<Record<string, unknown>>
  variableTypes: Readonly<Record<string, VariableType>>
  /** Поля объекта: `field:<путь>`. */
  fields: Readonly<Record<string, unknown>>
  /** Выбор инициатора для шага: `chosen_by_initiator`. */
  chosen?: readonly string[] | undefined
  /** Назначенные предыдущего шага: `previous_step.assignees`. */
  previousAssignees?: readonly string[] | undefined
  /** Назначенные шага таймера (не выполнившие): `step.assignee`. */
  stepAssignees?: readonly string[] | undefined
}

export interface ResolvedAssignee {
  userId: string
  /** Выражение, давшее назначение, — «почему назначен». */
  source: string
}

export type ResolveIssueCode = 'invalid' | 'empty' | 'runtime'

export interface ResolveIssue {
  expression: string
  code: ResolveIssueCode
  message: string
}

export interface ResolveResult {
  assignees: ResolvedAssignee[]
  issues: ResolveIssue[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Значение поля или переменной как список идентификаторов (`{id}` — тоже). */
function idsOf(value: unknown): string[] {
  const one = (item: unknown): string | null => {
    if (typeof item === 'string' && UUID.test(item)) return item.toLowerCase()
    if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id: unknown }).id
      return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null
    }
    return null
  }
  if (Array.isArray(value)) return value.map(one).filter((id): id is string => id !== null)
  const id = one(value)
  return id ? [id] : []
}

function fieldValue(fields: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = fields
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

class Resolver {
  constructor(
    private readonly context: ResolveContext,
    private readonly directory: AssigneeDirectory,
  ) {}

  async authorUnit(): Promise<string[]> {
    if (this.context.authorUnitId !== undefined) {
      return this.context.authorUnitId ? [this.context.authorUnitId] : []
    }
    if (!this.context.authorId) return []
    const unit = await this.directory.primaryUnit(this.context.authorId)
    return unit ? [unit] : []
  }

  async units(expr: AssigneeExpr): Promise<string[]> {
    switch (expr.kind) {
      case 'unit':
        return [expr.id]
      case 'unit_code': {
        const unit = await this.directory.unitByCode(expr.code)
        return unit ? [unit] : []
      }
      case 'author_unit':
        return this.authorUnit()
      case 'var':
        return idsOf(this.context.variables[expr.name])
      case 'field':
        return idsOf(fieldValue(this.context.fields, expr.path))
      default:
        return []
    }
  }

  async users(expr: AssigneeExpr): Promise<string[]> {
    const { context, directory } = this
    switch (expr.kind) {
      case 'user':
        return [expr.id]
      case 'group':
        return directory.groupMembers(expr.id)
      case 'unit':
      case 'unit_code':
      case 'author_unit': {
        const members = await Promise.all(
          (await this.units(expr)).map((unit) => directory.unitMembers(unit)),
        )
        return unique(members.flat())
      }
      case 'role':
        return directory.usersWithRole(expr.key, context.spaceId)
      case 'role_in_space':
        return directory.usersWithRoleInSpace(expr.key, context.spaceId)
      case 'var': {
        const value = context.variables[expr.name]
        const type = context.variableTypes[expr.name]
        if (type === 'group') {
          const members = await Promise.all(idsOf(value).map((id) => directory.groupMembers(id)))
          return unique(members.flat())
        }
        if (type === 'unit') {
          const members = await Promise.all(idsOf(value).map((id) => directory.unitMembers(id)))
          return unique(members.flat())
        }
        return idsOf(value)
      }
      case 'field':
        return idsOf(fieldValue(context.fields, expr.path))
      case 'author':
        return context.authorId ? [context.authorId] : []
      case 'initiator':
        return context.initiatorId ? [context.initiatorId] : []
      case 'chosen_by_initiator':
        return [...(context.chosen ?? [])]
      case 'previous_step':
        return [...(context.previousAssignees ?? [])]
      case 'step_assignees':
        return [...(context.stepAssignees ?? [])]
      case 'unit_head': {
        const heads = await Promise.all(
          (await this.units(expr.unit)).map((unit) => directory.unitHead(unit)),
        )
        return unique(heads.filter((id): id is string => Boolean(id)))
      }
      case 'manager': {
        const people = await this.users(expr.of)
        const managers = await Promise.all(people.map((id) => directory.manager(id)))
        return unique(managers.filter((id): id is string => Boolean(id)))
      }
    }
  }
}

/**
 * Назначенные по списку выражений: порядок выражений сохраняется (он задаёт
 * очередь последовательного согласования), повторы убираются, остаются только
 * активные пользователи. Пустое выражение — проблема `empty`; выражения,
 * известные только при исполнении, без данных — `runtime`.
 */
export async function resolveAssignees(
  expressions: readonly string[],
  context: ResolveContext,
  directory: AssigneeDirectory,
): Promise<ResolveResult> {
  const resolver = new Resolver(context, directory)
  const issues: ResolveIssue[] = []
  const collected: ResolvedAssignee[] = []
  for (const source of expressions) {
    let expr: AssigneeExpr
    try {
      expr = parseAssignee(source)
    } catch (error) {
      if (!(error instanceof AssigneeSyntaxError)) throw error
      issues.push({ expression: source, code: 'invalid', message: error.message })
      continue
    }
    const users = await resolver.users(expr)
    for (const userId of users) collected.push({ userId: userId.toLowerCase(), source })
    if (users.length === 0) {
      const runtime =
        (expr.kind === 'previous_step' && context.previousAssignees === undefined) ||
        (expr.kind === 'chosen_by_initiator' && context.chosen === undefined)
      issues.push({
        expression: source,
        code: runtime ? 'runtime' : 'empty',
        message: runtime
          ? 'Определяется при исполнении маршрута'
          : `Никто не назначен: ${formatAssignee(expr)}`,
      })
    }
  }
  const seen = new Set<string>()
  const ordered = collected.filter((item) => {
    if (seen.has(item.userId)) return false
    seen.add(item.userId)
    return true
  })
  const active = new Set(await directory.activeUsers(ordered.map((item) => item.userId)))
  return { assignees: ordered.filter((item) => active.has(item.userId)), issues }
}
