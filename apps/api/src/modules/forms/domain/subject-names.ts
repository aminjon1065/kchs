import type { FormSubject } from '@kchs/contracts'
import { directory } from '~/kernel/directory/port.js'
import { OrgService } from '~/modules/identity/public.js'

/**
 * Подписи назначений для матрицы контроля и авто-полей: название подразделения
 * и имя сотрудника берутся у модуля «Идентификация» через его публичный API.
 */
export async function subjectNames(subjects: readonly FormSubject[]): Promise<Map<string, string>> {
  const units = subjects.filter((item) => item.kind === 'unit').map((item) => item.id)
  const users = subjects.filter((item) => item.kind === 'user').map((item) => item.id)
  const out = new Map<string, string>()
  if (units.length > 0) {
    const briefs = await OrgService.briefs([...new Set(units)])
    for (const [id, brief] of briefs) out.set(`unit:${id}`, brief.name.ru)
  }
  if (users.length > 0) {
    const refs = await directory().refs([...new Set(users)])
    for (const [id, ref] of refs) out.set(`user:${id}`, ref.displayName)
  }
  return out
}

export const subjectKey = (subject: FormSubject): string => `${subject.kind}:${subject.id}`

/** Сотрудников подразделения без руководителя в деле — не больше. */
const FALLBACK_MEMBERS = 10

/**
 * Кому адресуется дело «Сдать сводку»: сотруднику, главе подразделения, а если
 * главы нет — его сотрудникам, иначе сдавать было бы некому.
 */
export async function submittersOf(subject: FormSubject): Promise<string[]> {
  if (subject.kind === 'user') return [subject.id]
  const head = await directory().unitHead(subject.id)
  if (head) return [head]
  const members = await directory().unitMembers(subject.id)
  return members.slice(0, FALLBACK_MEMBERS)
}

/** Кому уходит эскалация: руководителю назначенного. */
export async function managerOf(subject: FormSubject): Promise<string | null> {
  const [submitter] = await submittersOf(subject)
  return submitter ? directory().manager(submitter) : null
}
