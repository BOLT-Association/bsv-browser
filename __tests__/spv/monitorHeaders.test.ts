import { Monitor, utils } from '@bsv/wallet-toolbox-mobile'
import { regtestRules } from '@bsv/expo-wallet-toolbox/core/headers/chainRules'
import { announceChainTip, applyChainRulesToMonitorHeaders, copyHeaderUnderRules, requestProofCheck } from '@bsv/expo-wallet-toolbox/core/spv/monitorHeaders'
import { mineChain, mineHeader, type MinedHeader } from './helpers'

/** A mined test header as the header object the monitor handles. */
const asHeader = (h: MinedHeader) => ({ ...(utils.deserializeBaseBlockHeader(Array.from(h.bytes), 0) as any), height: h.height, hash: h.hash })

const chain = mineChain(3, { tag: 'monitor' })
const tip = asHeader(chain[2])

/** The parts of a Monitor the header path touches, with the toolbox's own methods on it. */
function monitorLike(tipHeader: unknown) {
  return {
    chain: 'main',
    chaintracks: { findChainTipHeader: async () => tipHeader },
    copyValidatedHeader: (Monitor.prototype as any).copyValidatedHeader,
    processNewBlockHeader: (Monitor.prototype as any).processNewBlockHeader,
    lastNewHeader: undefined as { height: number } | undefined,
    _tasks: [{ name: 'NewHeader', getHeader: undefined as undefined | (() => Promise<{ height: number; hash: string }>) }]
  }
}

describe('spv: the monitor validates headers under the chain rules', () => {
  it("control: the toolbox monitor refuses a regtest header (it demands mainnet proof of work)", () => {
    const m = monitorLike(tip)
    expect(() => m.processNewBlockHeader(tip)).toThrow(/proof-of-work/)
    expect(m.lastNewHeader).toBeUndefined()
  })

  it('accepts the verified regtest tip, so a new header reaches the monitor and proofs are sought', async () => {
    const m = monitorLike(tip)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    const polled = await m._tasks[0].getHeader!()
    expect(polled).toEqual(tip)
    m.processNewBlockHeader(polled)
    expect(m.lastNewHeader?.height).toBe(tip.height)
  })

  it('syncs the header chain before each poll reads the tip', async () => {
    const m = monitorLike(asHeader(chain[1]))
    // The sync is what advances the wallet's own chain: the tip read after it is the new one.
    const sync = jest.fn(async () => { m.chaintracks.findChainTipHeader = async () => tip })
    applyChainRulesToMonitorHeaders(m as never, regtestRules, sync)
    expect(await m._tasks[0].getHeader!()).toEqual(tip)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('a failed sync is not a failed poll: the tip already held is returned', async () => {
    const m = monitorLike(tip)
    applyChainRulesToMonitorHeaders(m as never, regtestRules, async () => { throw new Error('offline') })
    expect(await m._tasks[0].getHeader!()).toEqual(tip)
  })

  it('announceChainTip hands a tip the monitor has not seen to it at once, so proofs are sought without waiting for a poll', async () => {
    const m = monitorLike(tip)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    expect(await announceChainTip(m as never)).toBe(true)
    expect(m.lastNewHeader).toEqual(tip)
  })

  it('announceChainTip does nothing when the monitor already has that tip', async () => {
    const m = monitorLike(tip)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    await announceChainTip(m as never)
    const process = jest.spyOn(m, 'processNewBlockHeader')
    expect(await announceChainTip(m as never)).toBe(false)
    expect(process).not.toHaveBeenCalled()
  })

  it('announceChainTip never moves the monitor back to a lower tip', async () => {
    const m = monitorLike(tip)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    await announceChainTip(m as never)
    m.chaintracks.findChainTipHeader = async () => asHeader(chain[1])
    expect(await announceChainTip(m as never)).toBe(false)
    expect(m.lastNewHeader).toEqual(tip)
  })

  it('announceChainTip still refuses a tip that is not valid under the chain rules', async () => {
    const weak = asHeader(mineHeader({ previousHash: chain[2].hash, height: 4, work: false }))
    const m = monitorLike(weak)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    await expect(announceChainTip(m as never)).rejects.toThrow(/regtest rules/)
    expect(m.lastNewHeader).toBeUndefined()
  })

  it('requestProofCheck makes the proof task run on the next monitor cycle, as a new header does', () => {
    class CheckForProofs {
      static checkNow = false
      name = 'CheckForProofs'
    }
    const m = { _tasks: [{ name: 'NewHeader' }, new CheckForProofs()] }
    expect(requestProofCheck(m as never)).toBe(true)
    expect(CheckForProofs.checkNow).toBe(true)
  })

  it('requestProofCheck reports a monitor without the proof task instead of throwing', () => {
    expect(requestProofCheck({ _tasks: [{ name: 'NewHeader' }] } as never)).toBe(false)
  })

  it('still refuses a header that does not meet its declared target', async () => {
    const weak = asHeader(mineHeader({ previousHash: chain[2].hash, height: 4, work: false }))
    // Only meaningful if the unmined header really misses the target.
    expect(() => regtestRules.validate({ height: 4, hash: weak.hash, bits: weak.bits, time: weak.time })).toThrow()
    const m = monitorLike(weak)
    applyChainRulesToMonitorHeaders(m as never, regtestRules)
    await expect(m._tasks[0].getHeader!()).rejects.toThrow(/regtest rules/)
    expect(() => m.processNewBlockHeader(weak)).toThrow(/regtest rules/)
    expect(m.lastNewHeader).toBeUndefined()
  })

  it('refuses a header whose hash is not the hash of its fields', () => {
    const forged = { ...tip, merkleRoot: 'ab'.repeat(32) }
    expect(() => copyHeaderUnderRules(forged, 'header', regtestRules)).toThrow(/regtest rules/)
  })

  it('refuses bits other than the regtest limit, and anything that is not a header', () => {
    const harder = asHeader(mineHeader({ previousHash: chain[2].hash, height: 4, bits: 0x1f7fffff }))
    expect(() => copyHeaderUnderRules(harder, 'header', regtestRules)).toThrow(/regtest rules/)
    expect(() => copyHeaderUnderRules(null, 'header', regtestRules)).toThrow(/block header/)
    expect(() => copyHeaderUnderRules({ height: 1 }, 'header', regtestRules)).toThrow()
  })

  it('returns a copy holding only the header fields', () => {
    const copy = copyHeaderUnderRules({ ...tip, extra: 'x' }, 'header', regtestRules)
    expect(copy).toEqual(tip)
    expect(copy).not.toBe(tip)
  })
})
