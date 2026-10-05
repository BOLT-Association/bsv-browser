/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: a real (headless) wallet in spv mode against the regtest stack, reaching
 * only Arcade. Skipped unless SPV_LIVE=1.
 *
 *   SPV_LIVE=1 npx jest __tests__/spv/live --runInBand   # serial: headers.live forces a reorg
 *
 * Everything lives in memory: an in-memory SQLite database and a fresh random
 * wallet per test file. Nothing touches a real wallet or data directory.
 */
jest.mock('expo-sqlite', () => require('./sqliteShim.cjs'))
jest.mock('@react-native-community/netinfo', () => {
  const state = { isConnected: true, isInternetReachable: true }
  const api = { fetch: async () => state, refresh: async () => state, addEventListener: () => () => {}, configure: () => {} }
  return { __esModule: true, default: api, ...api, useNetInfo: () => state }
})
jest.mock('@bsv/expo-wallet-toolbox/core/diskSpace', () => ({
  availableDiskBytes: jest.fn(async () => 10_000_000_000),
  diskPressure: jest.fn(async () => ({ pressured: false }))
}))

import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { ARCADE, CHAINTRACKS, LIVE, mineUntilMined, spendCoinbase, until, arcadeStatus, rpc } from './stack'
import { makeHeadlessWallet, paymentFor, type HeadlessWallet } from './headlessWallet'

const d = LIVE ? describe : describe.skip
jest.setTimeout(900000)

const AMOUNT = 100_000

/** Fund `h` by a mined, Arcade-confirmed coinbase spend; returns the good and a tampered Atomic BEEF. */
async function fundingBeefs(h: HeadlessWallet) {
  const pay = paymentFor(h.identityKey)
  const tx = await spendCoinbase([{ lockingScript: new P2PKH().lock(pay.pubKeyHash), satoshis: AMOUNT }])
  const st = await mineUntilMined(tx.id('hex'))
  tx.merklePath = MerklePath.fromHex(st.merklePath)
  const good = tx.toAtomicBEEF()

  const bad = Transaction.fromHex(tx.toHex())
  const badMp = MerklePath.fromHex(st.merklePath)
  let sib: { hash?: string; txid?: boolean } | undefined
  for (const level of badMp.path) {
    sib = level.find(l => !l.txid && l.hash)
    if (sib) break
  }
  if (sib) sib.hash = 'ab'.repeat(32)
  bad.merklePath = badMp
  return { txid: tx.id('hex'), height: st.blockHeight!, good, tampered: bad.toAtomicBEEF(), pay }
}

const internalizeArgs = (beef: number[], pay: ReturnType<typeof paymentFor>) => ({
  tx: beef,
  outputs: [{ outputIndex: 0, protocol: 'wallet payment' as const, paymentRemittance: pay.remittance }],
  description: 'spv live funding'
})

async function syncUntil(h: HeadlessWallet, height: number) {
  await until(`wallet header chain reaches ${height}`, async () => {
    await h.syncHeaders()
    return h.store.tipHeight >= height
  }, { timeout: 120000, every: 2000 })
}

const balance = async (h: HeadlessWallet) => {
  const r = await h.wallet.listOutputs({ basket: 'default', limit: 100 })
  return r.outputs.reduce((a, o) => a + o.satoshis, 0)
}

d('live: headless wallet in spv mode', () => {
  let h: HeadlessWallet

  const seenUrls: string[] = []
  let tamperArcadeProofs = false

  beforeAll(async () => {
    h = await makeHeadlessWallet()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    // Sit in front of the (guarded) fetch: record every URL the wallet code asks for, and
    // optionally play a lying Arcade that corrupts the BUMP it returns for a tx.
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input.url ?? String(input))
      seenUrls.push(url)
      const res = await inner(input, init)
      if (tamperArcadeProofs && /\/tx\/[0-9a-f]{64}$/.test(url) && (!init || !init.method || init.method === 'GET')) {
        const body: any = await res.clone().json()
        if (body.merklePath) {
          const mp = MerklePath.fromHex(body.merklePath)
          for (const level of mp.path) {
            const sib = level.find(l => !l.txid && l.hash)
            if (sib) {
              sib.hash = 'ab'.repeat(32)
              break
            }
          }
          body.merklePath = mp.toHex()
        }
        return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
      }
      return res
    }) as typeof fetch
  })

  it('refuses a BEEF whose block the verified chain does not hold yet, and never asks the network', async () => {
    const f = await fundingBeefs(h)
    // The wallet has synced nothing: its verified chain is just the genesis anchor.
    expect(h.store.tipHeight).toBe(0)
    await expect(h.wallet.internalizeAction(internalizeArgs(f.good, f.pay))).rejects.toThrow()
    expect(await balance(h)).toBe(0)
    // After the wallet's own sync reaches the block, the same BEEF is accepted.
    await syncUntil(h, f.height)
    const r = await h.wallet.internalizeAction(internalizeArgs(f.good, f.pay))
    expect(r.accepted).toBe(true)
    expect(await balance(h)).toBe(AMOUNT)
  })

  it('rejects a tampered BUMP even though the chain holds the block', async () => {
    const f = await fundingBeefs(h)
    await syncUntil(h, f.height)
    const before = await balance(h)
    await expect(h.wallet.internalizeAction(internalizeArgs(f.tampered, f.pay))).rejects.toThrow()
    expect(await balance(h)).toBe(before)
    const ok = await h.wallet.internalizeAction(internalizeArgs(f.good, f.pay))
    expect(ok.accepted).toBe(true)
    expect(await balance(h)).toBe(before + AMOUNT)
  })

  it('spends through Arcade, and stores the proof only once its own chain verifies it', async () => {
    const dest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()).toHex()
    const sent = await h.wallet.createAction({
      description: 'spv live spend',
      outputs: [{ lockingScript: dest, satoshis: 5000, outputDescription: 'to nobody' }],
      options: { acceptDelayedBroadcast: false }
    })
    expect(sent.txid).toMatch(/^[0-9a-f]{64}$/)
    const txid = sent.txid!
    const seen = await until('Arcade verdict', async () => {
      const s = (await arcadeStatus(txid)).txStatus ?? ''
      return ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED', 'REJECTED'].includes(s) ? s : null
    }, { timeout: 30000, every: 500 })
    expect(seen).not.toBe('REJECTED')

    const st = await mineUntilMined(txid)
    // The block exists on the network, but the wallet has not synced to it: no proof may be stored.
    expect(h.store.tipHeight).toBeLessThan(st.blockHeight!)
    await h.checkForProofs()
    expect(await h.rows('SELECT provenTxId FROM proven_txs WHERE txid = ?', [txid])).toEqual([])

    await syncUntil(h, st.blockHeight!)
    if (process.env.SPV_LIVE_DEBUG) {
      const r: any = await h.services.getMerklePath(txid)
      const mp = r.merklePath
      console.log('getMerklePath result', r.error?.message, JSON.stringify(r.notes))
      if (mp) {
        const root = mp.computeRoot(txid)
        console.log('computed root', root, 'store root', h.store.verifiedRootForHeight(mp.blockHeight), 'valid?', await h.offline.isValidRootForHeight(root, mp.blockHeight))
      }
    }
    const log = await h.checkForProofs()
    if (process.env.SPV_LIVE_DEBUG) console.log(`CheckForProofs log: ${log}`)
    if (process.env.SPV_LIVE_DEBUG) {
      console.log('req rows', JSON.stringify(await h.rows('SELECT status, attempts, history, provenTxId FROM proven_tx_reqs WHERE txid = ?', [txid])))
    }
    const proven = await h.rows('SELECT height, merkleRoot FROM proven_txs WHERE txid = ?', [txid])
    expect(proven.length).toBe(1)
    expect(proven[0].height).toBe(st.blockHeight)
    expect(proven[0].merkleRoot).toBe(h.store.verifiedRootForHeight(st.blockHeight!))
    expect(proven[0].merkleRoot).toBe((await rpc('getblock', [st.blockHash, 1])).merkleroot)
  })

  it('does not store a proof from a lying Arcade, and stores the real one once Arcade tells the truth', async () => {
    const dest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()).toHex()
    const sent = await h.wallet.createAction({
      description: 'spv live spend 2',
      outputs: [{ lockingScript: dest, satoshis: 4000, outputDescription: 'to nobody' }],
      options: { acceptDelayedBroadcast: false }
    })
    const txid = sent.txid!
    const st = await mineUntilMined(txid)
    await syncUntil(h, st.blockHeight!)

    tamperArcadeProofs = true
    try {
      await h.checkForProofs()
    } finally {
      tamperArcadeProofs = false
    }
    expect(await h.rows('SELECT provenTxId FROM proven_txs WHERE txid = ?', [txid])).toEqual([])
    const req = await h.rows('SELECT status FROM proven_tx_reqs WHERE txid = ?', [txid])
    expect(req[0].status).not.toBe('completed')

    await h.checkForProofs()
    const proven = await h.rows('SELECT merkleRoot FROM proven_txs WHERE txid = ?', [txid])
    expect(proven.length).toBe(1)
    expect(proven[0].merkleRoot).toBe(h.store.verifiedRootForHeight(st.blockHeight!))
  })

  it('only ever talked to the configured Arcade and chaintracks, and a public indexer is refused', async () => {
    const hosts = new Set(seenUrls.map(u => new URL(u).host))
    const allowed = new Set([new URL(ARCADE).host, new URL(CHAINTRACKS).host])
    expect([...hosts].filter(x => !allowed.has(x))).toEqual([])
    expect(seenUrls.length).toBeGreaterThan(10)
    await expect(fetch('https://api.whatsonchain.com/v1/bsv/test/chain/info')).rejects.toThrow(/spv/i)
  })
})
