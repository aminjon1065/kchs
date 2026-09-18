import { CAPABILITIES } from '@kchs/contracts'
import { hasKey } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_GROUPS, capabilityLabelKey } from './capabilities.js'

describe('матрица способностей', () => {
  it('каждая способность из контрактов — ровно в одной группе', () => {
    const grouped = CAPABILITY_GROUPS.flatMap((group) => group.capabilities)
    expect([...grouped].sort()).toEqual([...CAPABILITIES].sort())
  })

  it('у каждой способности есть подпись в основном словаре', () => {
    expect(capabilityLabelKey('api_tokens.create')).toBe('admin.capabilities.apiTokensCreate')
    const missing = CAPABILITIES.filter(
      (capability) => !hasKey(capabilityLabelKey(capability), 'ru'),
    )
    expect(missing).toEqual([])
  })
})
