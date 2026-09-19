import { localizedText } from '@kchs/i18n'
import type { Step, StepType } from '@kchs/process'
import {
  Bell,
  BookMarked,
  CheckCheck,
  Eye,
  Flag,
  GitBranch,
  GitFork,
  Hourglass,
  ListChecks,
  PencilLine,
  PenLine,
  Plug,
  Undo2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useAssigneeLabel, useDesigner, useStepTitle } from './context.js'

const ICONS: Record<StepType, (className: string) => ReactNode> = {
  approval: (className) => <CheckCheck className={className} />,
  sign: (className) => <PenLine className={className} />,
  register: (className) => <BookMarked className={className} />,
  acknowledge: (className) => <Eye className={className} />,
  task: (className) => <ListChecks className={className} />,
  condition: (className) => <GitBranch className={className} />,
  parallel: (className) => <GitFork className={className} />,
  wait: (className) => <Hourglass className={className} />,
  notify: (className) => <Bell className={className} />,
  set: (className) => <PencilLine className={className} />,
  call: (className) => <Plug className={className} />,
  return: (className) => <Undo2 className={className} />,
  end: (className) => <Flag className={className} />,
}

export function StepIcon({ type, className = 'size-4' }: { type: StepType; className?: string }) {
  return <span aria-hidden>{ICONS[type](className)}</span>
}

/**
 * Краткое описание шага для карточки схемы: кто, как, сколько времени и
 * куда при отклонении — строками, словами интерфейса.
 */
export function useStepSummary(): (step: Step) => string[] {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const labelOf = useAssigneeLabel()
  const titleOf = useStepTitle()
  const { definition } = useDesigner()
  const people = (list: readonly string[]) => list.map(labelOf).join(', ')
  const due = (days: number | undefined) =>
    days === undefined ? [] : [t('processDesigner.summary.due', { count: days })]
  const target = (value: string | undefined): string => {
    if (!value || value === 'end:rejected') return t('processDesigner.summary.endRejected')
    if (value === 'continue') return t('processDesigner.summary.continue')
    if (value.startsWith('end:')) {
      return t('processDesigner.summary.outcome', { outcome: value.slice(4) })
    }
    return `«${titleOf(value, definition.steps[value])}»`
  }
  return (step) => {
    switch (step.type) {
      case 'approval': {
        const quorum =
          typeof step.quorum === 'number'
            ? t('processDesigner.summary.quorumN', { n: step.quorum })
            : t(`processDesigner.summary.quorum.${step.quorum}`)
        return [
          people(step.assignees),
          [
            t(`processDesigner.summary.mode.${step.mode}`),
            quorum,
            ...due(step.dueWorkingDays),
          ].join(' · '),
          t('processDesigner.summary.onReject', { target: target(step.onReject) }),
        ]
      }
      case 'sign':
        return [
          people(step.assignees),
          [
            t(`processDesigner.summary.mode.${step.mode}`),
            ...(step.requireMfa ? [t('processDesigner.summary.mfa')] : []),
            ...due(step.dueWorkingDays),
          ].join(' · '),
          t('processDesigner.summary.onRefuse', { target: target(step.onReject) }),
        ]
      case 'register':
        return [
          step.assignees?.length ? people(step.assignees) : t('processDesigner.summary.auto'),
          [
            ...(step.journal
              ? [t('processDesigner.summary.journal', { journal: step.journal })]
              : []),
            ...due(step.dueWorkingDays),
          ].join(' · '),
        ].filter(Boolean)
      case 'acknowledge':
        return [people(step.assignees), ...due(step.dueWorkingDays)]
      case 'task':
        return [
          localizedText(step.title, locale),
          [people(step.assignees), ...due(step.dueWorkingDays)].join(' · '),
        ]
      case 'condition':
        return [
          ...step.branches.map((branch) =>
            t('processDesigner.summary.branch', { if: branch.if, target: target(branch.next) }),
          ),
          ...(step.else ? [t('processDesigner.summary.else', { target: target(step.else) })] : []),
        ]
      case 'parallel':
        return [t(`processDesigner.summary.join.${step.join}`)]
      case 'wait':
        return [
          [
            ...(step.event ? [t('processDesigner.summary.waitEvent', { event: step.event })] : []),
            ...(step.durationWorkingDays !== undefined
              ? [t('processDesigner.summary.due', { count: step.durationWorkingDays })]
              : []),
            ...(step.until ? [t('processDesigner.summary.waitUntil', { until: step.until })] : []),
          ].join(' · '),
        ]
      case 'notify':
        return [people(typeof step.to === 'string' ? [step.to] : step.to)]
      case 'set':
        return [`${step.field} = ${JSON.stringify(step.value)}`]
      case 'call':
        return [step.action]
      case 'return':
        return [
          labelOf(step.to),
          t(`processDesigner.summary.reapproval.${step.reapproval}`),
          ...due(step.dueWorkingDays),
        ]
      case 'end':
        return [t('processDesigner.summary.outcome', { outcome: step.outcome })]
    }
  }
}
