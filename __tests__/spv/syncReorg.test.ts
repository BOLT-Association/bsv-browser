import { syncHeaders } from '@bsv/expo-wallet-toolbox/core/headers/syncHeaders'
import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { Utils } from '@bsv/sdk'
import { targetFromBits, workFromBits, type HeaderRules } from '@bsv/expo-wallet-toolbox/core/headers/chainRules'
import { concat, mineChain, mineHeader, REGTEST_BITS, type MinedHeader } from './helpers'

/** A chaintracks stand-in serving one chain (index = height). Swap `chain` to simulate a reorg. */
function remoteOf(initial: MinedHeader[]) {
  const state = { chain: initial, calls: 0 }
  return {
    state,
    client: {
      getPresentHeight: async () => state.chain.length - 1,
      getHeaders: async (height: number, count: number) => {
        state.calls++
        const slice = state.chain.slice(height, height + count)
        return Utils.toHex(Array.from(concat(slice)))
      }
    }
  }
}

const anchorOf = (g: MinedHeader) => ({ height: g.height, hash: g.hash })

async function syncedStore(chain: MinedHeader[]) {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(chain[0]))
  const r = remoteOf(chain)
  await syncHeaders({ store, client: r.client })
  return { store, r }
}

/** chain A: genesis + 6. branch B forks after height 3 (shares 0..3) and has `len` more headers. */
function fork(a: MinedHeader[], forkAt: number, len: number): MinedHeader[] {
  return [...a.slice(0, forkAt + 1), ...mineChain(len, { from: a[forkAt], tag: 'B' })]
}

describe('syncHeaders: reorgs by most work', () => {
  it('switches to a competing branch that has more work', async () => {
    const a = mineChain(6, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    const b = fork(a, 3, 5) // heights 4..8
    r.state.chain = b
    const res = await syncHeaders({ store, client: r.client })
    expect(store.tipHeight).toBe(8)
    expect(store.tipHash).toBe(b[8].hash)
    expect(store.hashForHeight(3)).toBe(a[3].hash)
    expect(store.hashForHeight(4)).toBe(b[4].hash)
    expect(res.reorgDepth).toBe(3) // heights 4..6 dropped
  })

  it('keeps its own chain when the competing branch has less work, and does not throw', async () => {
    const a = mineChain(6, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    // B is longer than our fork point but shorter than A overall, so the remote
    // reports a lower present height: nothing to do, tip must not move.
    r.state.chain = fork(a, 3, 2)
    const res = await syncHeaders({ store, client: r.client })
    expect(store.tipHash).toBe(a[6].hash)
    expect(res.reorgDepth).toBeUndefined()
  })

  it('switches to a branch that is heavier by exactly one header (control for the equal-work case)', async () => {
    const a = mineChain(6, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    const b = fork(a, 2, 4) // heights 3..6, same height as A, same work
    r.state.chain = [...b, mineHeader({ previousHash: b[6].hash, height: 7 })]
    // One more header on B makes B heavier, so this DOES switch (control).
    await syncHeaders({ store, client: r.client })
    expect(store.tipHash).toBe(r.state.chain[7].hash)
  })

  it('does not switch to an equal-work branch', async () => {
    const a = mineChain(6, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    const b = fork(a, 2, 4) // equal length: 0..6
    r.state.chain = b
    // present height == tip, so the loop never asks; equal work is not a reorg.
    await syncHeaders({ store, client: r.client })
    expect(store.tipHash).toBe(a[6].hash)
  })

  it('refuses a reorg deeper than the allowed depth and leaves the store untouched', async () => {
    const a = mineChain(10, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    r.state.chain = fork(a, 3, 12) // would drop 7 headers
    const res = await syncHeaders({ store, client: r.client, maxReorgDepth: 3 })
    expect(store.tipHash).toBe(a[10].hash)
    expect(store.count).toBe(10)
    expect(res.rejectedFork).toBe('too-deep')
  })

  it('refuses a heavier branch whose headers break the chain rules, and leaves the store untouched', async () => {
    const a = mineChain(6, { tag: 'A' })
    const { store, r } = await syncedStore(a)
    const good = fork(a, 3, 5)
    // Replace B's header 6 by one with a harder (non-regtest) difficulty: mined, linked, but illegal here.
    const bad = mineHeader({ previousHash: good[5].hash, height: 6, bits: 0x1f7fffff })
    const tail = mineChain(2, { from: bad, tag: 'B2' })
    r.state.chain = [...good.slice(0, 6), bad, ...tail]
    const res = await syncHeaders({ store, client: r.client })
    expect(store.tipHash).toBe(a[6].hash)
    expect(store.count).toBe(6)
    expect(res.rejectedFork).toBe('invalid')
  })

  it('still fails when the remote chain does not contain our anchor at all', async () => {
    const a = mineChain(3, { tag: 'A' })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(a[0]))
    const other = mineChain(3, { tag: 'Z' }) // a different genesis
    const r = remoteOf(other)
    await expect(syncHeaders({ store, client: r.client })).rejects.toThrow(/previous hash/i)
  })

  it('refuses a LONGER branch that carries less work (length is not the rule)', async () => {
    // Rules that accept any bits at or below 0x2100ffff, so branch B can be built
    // from easier headers (work 1 each) against ours at the regtest limit (work 2).
    const permissive: HeaderRules = {
      name: 'permissive-test',
      validate(h) {
        if (BigInt('0x' + h.hash) > targetFromBits(h.bits)) throw new Error('does not meet target')
      },
      workForBits: workFromBits
    }
    const a = mineChain(6, { tag: 'A' })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(a[0]), permissive)
    const r = remoteOf(a)
    await syncHeaders({ store, client: r.client })
    expect(store.tipHeight).toBe(6)

    // B forks after height 2, and is longer (heights 3..9) but each header is easier.
    let prev = a[2]
    const easy: MinedHeader[] = []
    for (let h = 3; h <= 9; h++) {
      const m = mineHeader({ previousHash: prev.hash, height: h, bits: 0x2100ffff, root: `${h}`.padStart(64, 'b') })
      easy.push(m)
      prev = m
    }
    expect(workFromBits(0x2100ffff) < workFromBits(REGTEST_BITS)).toBe(true)
    r.state.chain = [...a.slice(0, 3), ...easy]
    const res = await syncHeaders({ store, client: r.client })
    expect(store.tipHash).toBe(a[6].hash)
    expect(res.rejectedFork).toBe('less-work')
  })
})
