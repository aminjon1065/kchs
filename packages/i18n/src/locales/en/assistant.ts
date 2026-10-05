import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const assistant: DeepPartial<Dictionary['assistant']> = {
  disabled: 'The assistant is off',
  disabledHint: 'No AI provider is configured here, or you lack the capability to use it',
  hint: 'Ask about the open object: the assistant only searches and reads what you can access',
  hintGlobal: 'Ask anything: the assistant only searches what you can access',
  question: 'Question for the assistant',
  placeholder: 'For example: what do we know about this flood?',
  send: 'Ask',
  clear: 'Clear the thread',
  steps: 'What the assistant did',
  citations: 'Answer references',
  found: 'found {count}',
  createTask: 'Create an instruction',
  roles: { user: 'You', assistant: 'Assistant' },
}
