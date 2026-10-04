import { OfflineFirstChaintracks } from '@bsv/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks'
import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { concat, mineChain } from './helpers'

const LYING_ROOT = 'ee'.repeat(32)

async function windowOf(n: number) {
  const chain = mineChain(n, { tag: 'strict' })
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 0, hash: chain[0].hash })
  await store.append(concat(chain.slice(1)), 1)
  return { store, chain }
}

/** A remote that would happily agree with any forgery, and records every call. */
function lyingRemote() {
  const calls: string[] = []
  const rec =
    (name: string, value: unknown) =>
    async (...a: unknown[]) => {
      calls.push(`${name}(${a.join(',')})`)
      return value
    }
  const remote = {
    calls,
    findHeaderForHeight: rec('findHeaderForHeight', { merkleRoot: LYING_ROOT, height: 0 }),
    currentHeight: rec('currentHeight', 9_999_999),
    findChainTipHeader: rec('findChainTipHeader', undefined),
    findChainTipHash: rec('findChainTipHash', 'ff'.repeat(32)),
    findHeaderForBlockHash: rec('findHeaderForBlockHash', undefined),
    isValidRootForHeight: rec('isValidRootForHeight', true),
    getChain: rec('getChain', 'test'),
    getPresentHeight: rec('getPresentHeight', 20),
    getHeaders: rec('getHeaders', ''),
    subscribeHeaders: rec('subscribeHeaders', 'id'),
    subscribeReorgs: rec('subscribeReorgs', 'id'),
    unsubscribe: rec('unsubscribe', true)
  }
  return remote
}

const strict = (store?: HeaderStore) => {
  const remote = lyingRemote()
  const ct = new OfflineFirstChaintracks(remote as never, async () => true, undefined, { strict: true })
  if (store) ct.setStore(store)
  return { ct, remote }
}

describe('OfflineFirstChaintracks strict mode: the wallet trusts only its verified header chain', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('accepts a root that matches the verified window and never asks the remote', async () => {
    const { store, chain } = await windowOf(12)
    const { ct, remote } = strict(store)
    const root = store.rootForHeight(5)!
    expect(await ct.isValidRootForHeight(root, 5)).toBe(true)
    expect(chain.length).toBe(13)
    expect(remote.calls).toEqual([])
  })

  it('refuses a root the window disagrees with, even where the remote would agree (body height)', async () => {
    const { store } = await windowOf(20)
    const { ct, remote } = strict(store)
    expect(await ct.isValidRootForHeight(LYING_ROOT, 3)).toBe(false)
    expect(remote.calls).toEqual([])
  })

  it('refuses a disagreement in the last-6 tail instead of consulting the remote', async () => {
    const { store } = await windowOf(20)
    const { ct, remote } = strict(store)
    expect(await ct.isValidRootForHeight(LYING_ROOT, 18)).toBe(false)
    expect(remote.calls).toEqual([])
    expect(store.rootForHeight(18)).not.toBe(LYING_ROOT)
  })

  it('refuses a height the window does not cover and records it as a miss, with no remote call', async () => {
    const { store } = await windowOf(5)
    const { ct, remote } = strict(store)
    expect(await ct.isValidRootForHeight(LYING_ROOT, 50)).toBe(false)
    expect(ct.lastMissHeight).toBe(50)
    expect(remote.calls).toEqual([])
  })

  it('does not accept an unverified cached root (extra) outside the window', async () => {
    const { store } = await windowOf(5)
    await store.putExtraRoot(50, LYING_ROOT)
    const { ct } = strict(store)
    expect(await ct.isValidRootForHeight(LYING_ROOT, 50)).toBe(false)
  })

  it('without a store everything is refused (no remote fallback)', async () => {
    const { ct, remote } = strict()
    expect(await ct.isValidRootForHeight(LYING_ROOT, 1)).toBe(false)
    await expect(ct.findHeaderForHeight(1)).rejects.toThrow(/verified/i)
    await expect(ct.currentHeight()).rejects.toThrow(/verified/i)
    expect(remote.calls).toEqual([])
  })

  it('findHeaderForHeight answers from the verified window', async () => {
    const { store, chain } = await windowOf(8)
    const { ct, remote } = strict(store)
    const h = (await ct.findHeaderForHeight(4))!
    expect(h.height).toBe(4)
    expect(h.hash).toBe(chain[4].hash)
    expect(h.merkleRoot).toBe(store.rootForHeight(4))
    expect(h.previousHash).toBe(chain[3].hash)
    expect(remote.calls).toEqual([])
  })

  it('findHeaderForHeight outside the window is an error, not a remote answer', async () => {
    const { store } = await windowOf(8)
    const { ct, remote } = strict(store)
    await expect(ct.findHeaderForHeight(500)).rejects.toThrow(/verified/i)
    expect(remote.calls).toEqual([])
  })

  it('currentHeight and the chain tip come from the verified window', async () => {
    const { store, chain } = await windowOf(8)
    const { ct, remote } = strict(store)
    expect(await ct.currentHeight()).toBe(8)
    expect(await ct.findChainTipHash()).toBe(chain[8].hash)
    expect((await ct.findChainTipHeader())!.height).toBe(8)
    expect((await ct.findHeaderForBlockHash(chain[6].hash))!.height).toBe(6)
    expect(await ct.findHeaderForBlockHash('ab'.repeat(32))).toBeUndefined()
    expect(remote.calls).toEqual([])
  })
})

describe('non-strict mode is unchanged (control)', () => {
  it('still consults the remote for a height outside the window', async () => {
    const { store } = await windowOf(5)
    const remote = lyingRemote()
    const ct = new OfflineFirstChaintracks(remote as never, async () => true)
    ct.setStore(store)
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await ct.isValidRootForHeight(LYING_ROOT, 50)
    expect(remote.calls.some(c => c.startsWith('findHeaderForHeight'))).toBe(true)
  })
})
