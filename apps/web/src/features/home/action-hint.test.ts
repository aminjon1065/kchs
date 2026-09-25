import { hasKey } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'
import { actionHint } from './action-hint.js'

const action = (key: string, labelKey: string) => ({
  key,
  labelKey,
  variant: 'primary' as const,
  requiresComment: false,
})

describe('подсказка дела на «Моём дне»', () => {
  it('подпись первой кнопки, а не ключ действия', () => {
    const hint = actionHint({ actions: [action('resolve', 'inbox.actions.writeResolution')] })
    expect(hint).toBe('inbox.actions.writeResolution')
    expect(hasKey(hint, 'ru')).toBe(true)
  })

  it('у приглашения — «Ответить», у дела без кнопок — «Открыть»', () => {
    const invite = [
      action('accepted', 'inbox.actions.acceptInvite'),
      action('tentative', 'inbox.actions.tentative'),
      action('declined', 'inbox.actions.decline'),
    ]
    expect(actionHint({ actions: invite })).toBe('inbox.actions.respond')
    expect(hasKey('inbox.actions.respond', 'ru')).toBe(true)
    expect(actionHint({ actions: [] })).toBe('inbox.actions.open')
  })
})
