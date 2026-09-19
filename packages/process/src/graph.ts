import { nextOf, type ProcessDefinition, type Step } from './schema.js'

/**
 * Структура маршрута: место шага в параллельных ветвях, переходы верхнего
 * уровня и определение с шагами, вставленными условиями при запуске.
 */
export interface BranchPlace {
  /** Ключ параллельного шага. */
  parent: string
  branch: number
  index: number
}

/** Место каждого шага ветвей (первое вхождение; повторы ловит проверка). */
export function branchPlaces(def: Pick<ProcessDefinition, 'steps'>): Map<string, BranchPlace> {
  const places = new Map<string, BranchPlace>()
  for (const [key, step] of Object.entries(def.steps)) {
    if (step.type !== 'parallel') continue
    step.branches.forEach((keys, branch) => {
      keys.forEach((member, index) => {
        if (!places.has(member)) places.set(member, { parent: key, branch, index })
      })
    })
  }
  return places
}

/** Цель перехода при отклонении — шаг, а не `continue`/`end:…`. */
export function rejectStepTarget(target: string | undefined): string | null {
  if (!target || target === 'continue' || target.startsWith('end:')) return null
  return target
}

/** Все шаги внутри параллельного шага (с вложенными параллельными). */
export function descendantsOf(def: Pick<ProcessDefinition, 'steps'>, key: string): string[] {
  const step = def.steps[key]
  if (step?.type !== 'parallel') return []
  const out: string[] = []
  const visit = (parent: string, seen: Set<string>) => {
    const node = def.steps[parent]
    if (node?.type !== 'parallel' || seen.has(parent)) return
    seen.add(parent)
    for (const keys of node.branches) {
      for (const member of keys) {
        out.push(member)
        visit(member, seen)
      }
    }
  }
  visit(key, new Set())
  return out
}

/**
 * Переходы верхнего уровня: `next`, ветви условия, отклонение (у шагов в
 * параллельных ветвях — от внешнего параллельного шага).
 */
export function topLevelEdges(def: Pick<ProcessDefinition, 'steps'>): Map<string, string[]> {
  const places = branchPlaces(def)
  const edges = new Map<string, string[]>()
  for (const [key, step] of Object.entries(def.steps)) {
    if (places.has(key)) continue
    const out = new Set<string>(ownEdges(step))
    if (step.type === 'parallel') {
      for (const inner of descendantsOf(def, key)) {
        const innerStep = def.steps[inner]
        if (!innerStep) continue
        const target = rejectStepTarget(rejectTargetOf(innerStep))
        if (target) out.add(target)
      }
    }
    edges.set(key, [...out])
  }
  return edges
}

function rejectTargetOf(step: Step): string | undefined {
  return step.type === 'approval' || step.type === 'sign' ? step.onReject : undefined
}

function ownEdges(step: Step): string[] {
  const out: string[] = []
  const next = nextOf(step)
  if (next) out.push(next)
  const reject = rejectStepTarget(rejectTargetOf(step))
  if (reject) out.push(reject)
  if (step.type === 'condition') {
    for (const branch of step.branches) out.push(branch.next)
    if (step.else) out.push(step.else)
  }
  return out
}

/** Ключ шага, который вставляет условие `index`. */
export function conditionKey(def: Pick<ProcessDefinition, 'conditions'>, index: number): string {
  return def.conditions[index]?.key ?? `cond_${index + 1}`
}

function redirect(step: Step, from: string, to: string): Step {
  const copy = structuredClone(step) as Step & { next?: string; onReject?: string }
  if (copy.next === from) copy.next = to
  if ((copy.type === 'approval' || copy.type === 'sign') && copy.onReject === from) {
    copy.onReject = to
  }
  if (copy.type === 'condition') {
    for (const branch of copy.branches) if (branch.next === from) branch.next = to
    if (copy.else === from) copy.else = to
  }
  return copy
}

/**
 * Определение экземпляра — с шагами, которые вставили условия запуска: каждая
 * ссылка на `insertBefore` ведёт к вставленному шагу, а тот — к `insertBefore`.
 * Несколько вставок перед одним шагом идут в порядке условий. Условия в
 * результате уже применены — список пуст.
 */
export function applyConditions(
  def: ProcessDefinition,
  applied: readonly number[],
): ProcessDefinition {
  let steps: Record<string, Step> = { ...def.steps }
  let start = def.start
  for (const index of [...new Set(applied)].sort((a, b) => a - b)) {
    const condition = def.conditions[index]
    if (!condition) continue
    const key = conditionKey(def, index)
    const target = condition.insertBefore
    steps = Object.fromEntries(
      Object.entries(steps).map(([name, step]) => [name, redirect(step, target, key)]),
    )
    if (start === target) start = key
    steps[key] = { ...structuredClone(condition.step), next: target } as Step
  }
  return { ...def, start, steps, conditions: [] }
}
