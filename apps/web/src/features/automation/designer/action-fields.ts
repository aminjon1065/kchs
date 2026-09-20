import type { RuleAction, RuleActionType } from '@kchs/contracts'

/**
 * Поля действий правила для конструктора (ADR-0096): вид ввода и ключ
 * словаря. Значения действий — шаблоны `{{…}}` и выражения назначений, поэтому
 * почти всё это однострочные поля; списки получателей — многострочные.
 */
export type FieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'list' | 'map' | 'select'

export interface ActionField {
  key: string
  kind: FieldKind
  /** Ключ словаря: `automation.actionFields.<key>`. */
  label: string
  options?: readonly string[]
}

const OBJECT: ActionField = { key: 'object', kind: 'text', label: 'object' }

export const ACTION_FIELDS: Record<RuleActionType, ActionField[]> = {
  notify: [
    { key: 'to', kind: 'list', label: 'to' },
    { key: 'text', kind: 'textarea', label: 'text' },
    { key: 'channels', kind: 'list', label: 'channels' },
    OBJECT,
  ],
  create_task: [
    { key: 'title', kind: 'text', label: 'title' },
    { key: 'description', kind: 'textarea', label: 'description' },
    { key: 'assignee', kind: 'text', label: 'assignee' },
    { key: 'coAssignees', kind: 'list', label: 'coAssignees' },
    { key: 'controller', kind: 'text', label: 'controller' },
    { key: 'dueWorkingDays', kind: 'number', label: 'dueWorkingDays' },
    { key: 'dueAt', kind: 'text', label: 'dueAt' },
    { key: 'priority', kind: 'number', label: 'priority' },
    { key: 'source', kind: 'text', label: 'source' },
  ],
  update_fields: [{ key: 'fields', kind: 'map', label: 'fields' }, OBJECT],
  set_status: [
    { key: 'status', kind: 'text', label: 'status' },
    { key: 'comment', kind: 'textarea', label: 'comment' },
    OBJECT,
  ],
  assign: [
    { key: 'assignee', kind: 'text', label: 'assignee' },
    { key: 'role', kind: 'select', label: 'role', options: ['responsible', 'controller'] },
    OBJECT,
  ],
  create_document: [
    { key: 'typeKey', kind: 'text', label: 'typeKey' },
    { key: 'subject', kind: 'text', label: 'subject' },
    { key: 'fields', kind: 'map', label: 'fields' },
    { key: 'linkToSource', kind: 'boolean', label: 'linkToSource' },
  ],
  start_process: [
    { key: 'definitionKey', kind: 'text', label: 'definitionKey' },
    { key: 'variables', kind: 'map', label: 'variables' },
    OBJECT,
  ],
  add_link: [
    { key: 'target', kind: 'text', label: 'target' },
    { key: 'kind', kind: 'text', label: 'kind' },
    OBJECT,
  ],
  add_tag: [{ key: 'tag', kind: 'text', label: 'tag' }, OBJECT],
  post_message: [
    { key: 'text', kind: 'textarea', label: 'text' },
    { key: 'conversation', kind: 'text', label: 'conversation' },
  ],
  create_event: [
    { key: 'title', kind: 'text', label: 'title' },
    { key: 'startsAt', kind: 'text', label: 'startsAt' },
    { key: 'durationMinutes', kind: 'number', label: 'durationMinutes' },
    { key: 'participants', kind: 'list', label: 'participants' },
    { key: 'calendarId', kind: 'text', label: 'calendarId' },
  ],
  send_email: [
    { key: 'to', kind: 'list', label: 'to' },
    { key: 'subject', kind: 'text', label: 'subjectEmail' },
    { key: 'body', kind: 'textarea', label: 'body' },
  ],
  send_telegram: [
    { key: 'to', kind: 'list', label: 'to' },
    { key: 'text', kind: 'textarea', label: 'text' },
    OBJECT,
  ],
  webhook: [
    { key: 'url', kind: 'text', label: 'url' },
    { key: 'method', kind: 'select', label: 'method', options: ['POST', 'PUT'] },
    { key: 'headers', kind: 'map', label: 'headers' },
    { key: 'payload', kind: 'map', label: 'payload' },
    { key: 'secret', kind: 'text', label: 'secret' },
  ],
  ai_task: [
    { key: 'prompt', kind: 'textarea', label: 'prompt' },
    { key: 'target', kind: 'select', label: 'target', options: ['comment', 'field'] },
    OBJECT,
  ],
  wait: [{ key: 'minutes', kind: 'number', label: 'minutes' }],
  stop: [{ key: 'when', kind: 'text', label: 'when' }],
}

/** Заготовка действия: значения по умолчанию совпадают со схемой контракта. */
export function defaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case 'notify':
      return { type, to: [], text: '', channels: ['app'], object: '{{object.id}}' }
    case 'create_task':
      return {
        type,
        title: '',
        description: null,
        assignee: '',
        coAssignees: [],
        controller: null,
        dueWorkingDays: 3,
        dueAt: null,
        priority: 3,
        source: '{{object.id}}',
      }
    case 'update_fields':
      return { type, fields: {}, object: '{{object.id}}' }
    case 'set_status':
      return { type, status: '', comment: null, object: '{{object.id}}' }
    case 'assign':
      return { type, assignee: '', role: 'responsible', object: '{{object.id}}' }
    case 'create_document':
      return {
        type,
        typeKey: '',
        subject: '',
        templateId: null,
        spaceId: null,
        fields: {},
        linkToSource: true,
      }
    case 'start_process':
      return { type, definitionKey: '', variables: {}, object: '{{object.id}}' }
    case 'add_link':
      return { type, target: '', kind: 'related', object: '{{object.id}}' }
    case 'add_tag':
      return { type, tag: '', object: '{{object.id}}' }
    case 'post_message':
      return { type, text: '', conversation: 'object' }
    case 'create_event':
      return {
        type,
        calendarId: null,
        title: '',
        startsAt: '{{now}}',
        durationMinutes: 60,
        participants: [],
      }
    case 'send_email':
      return { type, to: [], subject: '', body: '' }
    case 'send_telegram':
      return { type, to: [], text: '', object: '{{object.id}}' }
    case 'webhook':
      return { type, url: 'https://', method: 'POST', headers: {}, payload: {}, secret: null }
    case 'ai_task':
      return { type, prompt: '', target: { kind: 'comment' }, object: '{{object.id}}' }
    case 'wait':
      return { type, minutes: 60 }
    case 'stop':
      return { type, when: null }
  }
}
