import { resolveHeaderSetup } from '@bsv/expo-wallet-toolbox/core/spv/headerSetup'
import { regtestRules } from '@bsv/expo-wallet-toolbox/core/headers/chainRules'
import { HEADER_CHECKPOINTS } from '@bsv/expo-wallet-toolbox/core/headers/checkpoints'

describe('resolveHeaderSetup', () => {
  it('uses the built-in checkpoint and default rules when nothing is overridden', () => {
    expect(resolveHeaderSetup('main', {})).toEqual({ anchor: HEADER_CHECKPOINTS.main, rules: undefined })
  })
  it('an spv anchor replaces the built-in checkpoint', () => {
    const anchor = { height: 0, hash: 'ab'.repeat(32) }
    expect(resolveHeaderSetup('ttn', { anchor })!.anchor).toEqual(anchor)
  })
  it('regtest rules are selected by name', () => {
    expect(resolveHeaderSetup('ttn', { rules: 'regtest', anchor: { height: 0, hash: 'ab'.repeat(32) } })!.rules).toBe(regtestRules)
  })
  it('regtest rules without an anchor are refused: a built-in checkpoint is not a regtest chain', () => {
    expect(() => resolveHeaderSetup('ttn', { rules: 'regtest' })).toThrow(/anchor/i)
  })
  it('returns undefined for a chain with no checkpoint and no override', () => {
    expect(resolveHeaderSetup('mock', {})).toBeUndefined()
  })

  describe('in spv mode difficulty rules must exist for the chain (fails closed)', () => {
    const anchor = { height: 0, hash: 'ab'.repeat(32) }
    it('refuses main, test and ttn with the default rules: retargeting is not implemented for them', () => {
      for (const chain of ['main', 'test', 'ttn']) {
        expect(() => resolveHeaderSetup(chain, {}, 'spv')).toThrow(/difficulty|rules/i)
      }
    })
    it('accepts regtest rules with an anchor', () => {
      expect(resolveHeaderSetup('ttn', { rules: 'regtest', anchor }, 'spv')!.rules).toBe(regtestRules)
    })
    it('public mode is unchanged (control)', () => {
      expect(resolveHeaderSetup('main', {}, 'public')!.anchor).toEqual(HEADER_CHECKPOINTS.main)
    })
  })
})
