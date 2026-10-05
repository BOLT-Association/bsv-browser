/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: the verified header chain against the real regtest stack, through
 * Arcade's chaintracks only. Skipped unless SPV_LIVE=1.
 *
 *   docker ps                      # stack up (spv-testnet: stack.ps1 up)
 *   SPV_LIVE=1 npx jest __tests__/spv/live --runInBand   # serial: the reorg test rewrites the chain
 *
 * Uses an in-memory header file system: no wallet, no real data directory.
 * The forced-reorg test stops the stack's miner and starts it again afterwards.
 */
import { RawChaintracksClient } from '@bsv/expo-wallet-toolbox/core/spv/rawChaintracksClient'
import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { OfflineFirstChaintracks } from '@bsv/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks'
import { syncHeaders } from '@bsv/expo-wallet-toolbox/core/headers/syncHeaders'
import {
  CHAINTRACKS,
  chaintracksHeader,
  height as nodeHeight,
  LIVE,
  mine,
  nodeFetch,
  REGTEST_GENESIS,
  rpc,
  startMiner,
  stopMiner,
  until
} from './stack'

const d = LIVE ? describe : describe.skip
jest.setTimeout(600000)

const client = () => new RawChaintracksClient(CHAINTRACKS, nodeFetch)
const anchor = { height: 0, hash: REGTEST_GENESIS }
const open = () => HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)

async function syncToNodeTip(store: HeaderStore) {
  const c = client()
  const tip = await nodeHeight()
  await until(`chaintracks at ${tip}`, async () => (await c.getPresentHeight()) >= tip, {
    timeout: 120000,
    every: 2000
  })
  return syncHeaders({ store, client: c })
}

d('live: verified header chain on regtest', () => {
  it('chaintracks serves the pinned regtest genesis (independent of the wallet)', async () => {
    const h0 = await chaintracksHeader(0)
    expect(h0?.hash).toBe(REGTEST_GENESIS)
    expect(await rpc('getblockhash', [0])).toBe(REGTEST_GENESIS)
  })

  it("syncs from genesis, and every verified root equals the node's own", async () => {
    const store = await open()
    const r = await syncToNodeTip(store)
    expect(r.rejectedFork).toBeUndefined()
    expect(store.tipHeight).toBeGreaterThan(50)
    expect(store.tipHash).toBe(await rpc('getblockhash', [store.tipHeight]))
    for (const h of [1, 2, 50, Math.floor(store.tipHeight / 2), store.tipHeight - 10]) {
      const block = await rpc('getblock', [await rpc('getblockhash', [h]), 1])
      expect(store.verifiedRootForHeight(h)).toBe(block.merkleroot)
      expect(store.hashForHeight(h)).toBe(block.hash)
    }
  })

  it('strict mode answers from the verified chain and never touches the remote', async () => {
    const store = await open()
    await syncToNodeTip(store)
    // Record every property the wallet touches on the remote. Strict mode may use
    // only the transport (it syncs through the sync's own client, not this one).
    const touched: string[] = []
    const raw = client()
    const remote = new Proxy(raw, {
      get(t, k, r) {
        touched.push(String(k))
        return Reflect.get(t, k, r)
      }
    })
    const ct = new OfflineFirstChaintracks(remote as never, async () => true, undefined, { strict: true })
    ct.setStore(store)
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const h = 40
    const root = store.verifiedRootForHeight(h)!
    expect(await ct.isValidRootForHeight(root, h)).toBe(true)
    expect(await ct.isValidRootForHeight('ee'.repeat(32), h)).toBe(false)
    expect(await ct.isValidRootForHeight(root, store.tipHeight + 1000)).toBe(false)
    expect(await ct.currentHeight()).toBe(store.tipHeight)
    expect((await ct.findHeaderForHeight(h))!.hash).toBe(store.hashForHeight(h))
    await expect(ct.findHeaderForHeight(store.tipHeight + 1000)).rejects.toThrow(/verified/)
    expect(touched).toEqual([])
  })

  it('rejects a chaintracks response with a forged merkle root and keeps the verified prefix', async () => {
    const store = await open()
    const c = client()
    const real = c.getHeaders.bind(c)
    // A lying chaintracks: flips one byte of header 30's merkle root in the chunk.
    jest.spyOn(c, 'getHeaders').mockImplementation(async (h: number, n: number) => {
      const hex = await real(h, n)
      if (h > 30 || h + n <= 30) return hex
      const at = (30 - h) * 160 + 2 * 36 + 4
      const flipped = ((parseInt(hex.slice(at, at + 2), 16) ^ 0xff) & 0xff).toString(16).padStart(2, '0')
      return hex.slice(0, at) + flipped + hex.slice(at + 2)
    })
    const tip = await nodeHeight()
    await until('chaintracks synced', async () => (await c.getPresentHeight()) >= tip, {
      timeout: 120000,
      every: 2000
    })
    await expect(syncHeaders({ store, client: c, chunkSize: 20 })).rejects.toThrow()
    // chunks before the forged header landed (verified); the chunk holding 30 did not.
    expect(store.tipHeight).toBeLessThan(30)
    expect(store.tipHash).toBe(await rpc('getblockhash', [store.tipHeight]))
  })

  it('follows a real reorg to the heavier branch', async () => {
    stopMiner()
    try {
      const store = await open()
      await syncToNodeTip(store)
      const base = await nodeHeight()
      await mine(3)
      const branchA: string[] = []
      for (let h = base + 1; h <= base + 3; h++) branchA.push(await rpc('getblockhash', [h]))
      await syncToNodeTip(store)
      expect(store.tipHash).toBe(branchA[2])

      await rpc('invalidateblock', [branchA[0]])
      await until('node back at base', async () => (await nodeHeight()) === base, { timeout: 60000 })
      await mine(4)
      const tipB = await rpc('getblockhash', [base + 4])
      expect(tipB).not.toBe(branchA[2])
      const c = client()
      await until('chaintracks reorged', async () => (await chaintracksHeader(base + 4))?.hash === tipB, {
        timeout: 180000,
        every: 2000
      })

      const r = await syncHeaders({ store, client: c })
      expect(r.reorgDepth).toBe(3)
      expect(store.tipHeight).toBe(base + 4)
      expect(store.tipHash).toBe(tipB)
      expect(store.hashForHeight(base + 1)).toBe(await rpc('getblockhash', [base + 1]))
      expect(store.hashForHeight(base + 1)).not.toBe(branchA[0])
    } finally {
      startMiner()
    }
  })
})
