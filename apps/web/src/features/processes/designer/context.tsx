import type { PrincipalRef, RoleInfo } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import type { DefinitionIssue, ProcessCatalog, Step } from '@kchs/process'
import { createContext, useContext } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { describeAssignee } from '../assignees.js'
import type { Definition } from '../model.js'

export type Selection =
  | { kind: 'step'; key: string }
  | { kind: 'route'; section: 'general' | 'variables' | 'timers' | 'conditions' }

export interface DesignerContextValue {
  definition: Definition
  /** Правка определения чистой функцией модели. */
  update: (change: (definition: Definition) => Definition) => void
  issues: readonly DefinitionIssue[]
  selection: Selection
  select: (selection: Selection) => void
  catalog: ProcessCatalog | undefined
  roles: readonly RoleInfo[]
  principals: ReadonlyMap<string, PrincipalRef>
  readOnly: boolean
}

const DesignerContext = createContext<DesignerContextValue | null>(null)

export const DesignerProvider = DesignerContext.Provider

export function useDesigner(): DesignerContextValue {
  const value = useContext(DesignerContext)
  if (!value) throw new Error('useDesigner() outside of DesignerProvider')
  return value
}

/** Подпись выражения назначения словами: люди и подразделения — именами. */
export function useAssigneeLabel(): (expression: string) => string {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { definition, roles, principals, catalog } = useDesigner()
  const fields = catalog?.objectTypes.find((item) => item.type === definition.objectType)?.fields
  return (expression) => {
    const description = describeAssignee(expression)
    switch (description.kind) {
      case 'user':
      case 'unit':
      case 'group':
        return principals.get(description.key)?.title ?? t('processDesigner.assignee.unknown')
      case 'role':
      case 'role_in_space': {
        const role = roles.find((item) => item.key === description.role)
        const name = role
          ? localizedText(role.name, locale)
          : ['viewer', 'member', 'editor', 'admin'].includes(description.role)
            ? t(`access.spaceRoles.${description.role}`)
            : description.role
        return t(
          description.kind === 'role'
            ? 'processDesigner.assignee.role'
            : 'processDesigner.assignee.roleInSpace',
          { role: name },
        )
      }
      case 'variable': {
        const variable = definition.variables[description.name]
        return t('processDesigner.assignee.variable', {
          name: variable ? localizedText(variable.label, locale) : description.name,
        })
      }
      case 'field': {
        const hint = fields?.find((item) => item.path === description.name)
        return t('processDesigner.assignee.field', {
          name: hint ? localizedText(hint.label, locale) : description.name,
        })
      }
      case 'unit_head_code':
        return t('processDesigner.assignee.headByCode', { code: description.code })
      case 'expression':
        return description.source
      default:
        return t(`processDesigner.assignee.kinds.${description.kind}`)
    }
  }
}

/** Название шага: своё или название типа. */
export function useStepTitle(): (key: string, step: Step | undefined) => string {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (key, step) => {
    if (!step) return key
    const own = step.name ? localizedText(step.name, locale).trim() : ''
    return own || t(`processDesigner.types.${step.type}`)
  }
}
