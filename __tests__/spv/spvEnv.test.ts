import { spvOptionsFromEnv } from '../../utils/spvEnv'

describe('spvOptionsFromEnv', () => {
  it('returns undefined when nothing is set', () => {
    expect(spvOptionsFromEnv({})).toBeUndefined()
  })
  it('reads rules and the anchor', () => {
    expect(
      spvOptionsFromEnv({
        EXPO_PUBLIC_SPV_RULES: 'regtest',
        EXPO_PUBLIC_SPV_ANCHOR_HEIGHT: '0',
        EXPO_PUBLIC_SPV_ANCHOR_HASH: 'ab'.repeat(32)
      })
    ).toEqual({ rules: 'regtest', anchor: { height: 0, hash: 'ab'.repeat(32) } })
  })
  it('treats empty strings as unset', () => {
    expect(spvOptionsFromEnv({ EXPO_PUBLIC_SPV_RULES: '', EXPO_PUBLIC_SPV_ANCHOR_HASH: '' })).toBeUndefined()
  })
  it('refuses a half-stated anchor rather than ignoring it', () => {
    expect(() => spvOptionsFromEnv({ EXPO_PUBLIC_SPV_ANCHOR_HEIGHT: '0' })).toThrow(/anchor/i)
    expect(() => spvOptionsFromEnv({ EXPO_PUBLIC_SPV_ANCHOR_HASH: 'ab'.repeat(32) })).toThrow(/anchor/i)
  })
  it('refuses a non-numeric height', () => {
    expect(() =>
      spvOptionsFromEnv({ EXPO_PUBLIC_SPV_ANCHOR_HEIGHT: 'zero', EXPO_PUBLIC_SPV_ANCHOR_HASH: 'ab'.repeat(32) })
    ).toThrow(/height/i)
  })
})
