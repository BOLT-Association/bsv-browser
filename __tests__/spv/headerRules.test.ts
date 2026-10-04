import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { concat, mineChain, mineHeader, mineInvalid, REGTEST_BITS } from './helpers'

const genesis = () => mineChain(0, { tag: 'rules' })[0]
const anchorOf = (g: { height: number; hash: string }) => ({ height: g.height, hash: g.hash })

describe('header rules: regtest chain', () => {
  it('accepts a regtest chain at the regtest limit', async () => {
    const g = genesis()
    const kids = mineChain(5, { from: g, tag: 'rules' })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(g))
    expect(await store.append(concat(kids), 1)).toBe(5)
    expect(store.tipHeight).toBe(5)
  })

  it('the default (toolbox) rules still refuse regtest bits: control for the above', async () => {
    const g = genesis()
    const kids = mineChain(1, { from: g, tag: 'rules' })
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', anchorOf(g))
    await expect(store.append(concat(kids), 1)).rejects.toThrow()
  })

  it('refuses bits above the regtest proof-of-work limit even when the hash meets them', async () => {
    const g = genesis()
    // 0x2100ffff is an easier target than the regtest limit 0x207fffff.
    const easy = mineHeader({ previousHash: g.hash, height: 1, bits: 0x2100ffff })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(g))
    await expect(store.append(concat([easy]), 1)).rejects.toThrow(/limit|bits|difficulty/i)
    expect(store.count).toBe(0)
  })

  it('refuses a difficulty change on a chain that has no retargeting', async () => {
    const g = genesis()
    // Genuinely harder, genuinely mined, but regtest never retargets.
    const harder = mineHeader({ previousHash: g.hash, height: 1, bits: 0x1f7fffff })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(g))
    await expect(store.append(concat([harder]), 1)).rejects.toThrow(/limit|bits|difficulty/i)
  })

  it('refuses a header whose hash does not meet its target', async () => {
    const g = genesis()
    const bad = mineInvalid({ previousHash: g.hash, height: 1 })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(g))
    await expect(store.append(concat([bad]), 1)).rejects.toThrow(/target/i)
    expect(store.count).toBe(0)
  })
})

describe('header store reload', () => {
  it('re-validates every stored header on open and drops a tampered window', async () => {
    const g = genesis()
    const kids = mineChain(4, { from: g, tag: 'rules' })
    const fs = memoryHeaderFs()
    const store = await HeaderStore.open(fs, 'regtest', anchorOf(g))
    await store.append(concat(kids), 1)
    expect(store.count).toBe(4)

    // Flip a merkle-root byte in header 3 on disk. Linkage of header 4 and the
    // header's own PoW both break; the metadata still claims count=4.
    const bin = (await fs.readBytes('regtest.bin'))!.slice()
    bin[2 * 80 + 40] ^= 0xff
    await fs.writeBytes('regtest.bin', bin)

    const reopened = await HeaderStore.open(fs, 'regtest', anchorOf(g))
    expect(reopened.count).toBe(0)
    expect(reopened.rootForHeight(3)).toBeUndefined()
  })

  it('keeps an untampered window across a reopen', async () => {
    const g = genesis()
    const kids = mineChain(4, { from: g, tag: 'rules' })
    const fs = memoryHeaderFs()
    const store = await HeaderStore.open(fs, 'regtest', anchorOf(g))
    await store.append(concat(kids), 1)
    const reopened = await HeaderStore.open(fs, 'regtest', anchorOf(g))
    expect(reopened.count).toBe(4)
  })
})

describe('chain work', () => {
  it('sums work per header and exposes the work between two heights', async () => {
    const g = genesis()
    const kids = mineChain(3, { from: g, tag: 'rules' })
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchorOf(g))
    await store.append(concat(kids), 1)
    const one = store.workBetween(1, 1)
    expect(one > BigInt(0)).toBe(true)
    expect(store.workBetween(1, 3)).toBe(one * BigInt(3))
    expect(store.workBetween(2, 1)).toBe(BigInt(0))
    expect(REGTEST_BITS).toBe(0x207fffff)
  })
})
