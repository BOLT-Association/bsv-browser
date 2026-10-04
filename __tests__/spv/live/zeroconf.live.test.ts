/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: zero-conf in spv mode against the regtest stack. A payment whose transaction is
 * not mined is accepted only once Arcade has seen it on the network, and then it can be
 * spent before any block. The stack's miner is stopped for the whole file (and started
 * again afterwards), so "unmined" stays true until the test mines by hand.
 * Skipped unless SPV_LIVE=1.
 *
 *   SPV_LIVE=1 npx jest __tests__/spv/live --runInBand
 */
jest.mock('expo-sqlite', () => require('./sqliteShim.cjs'))
jest.mock('@bsv/expo-wallet-toolbox/core/diskSpace', () => ({
  availableDiskBytes: jest.fn(async () => 10_000_000_000),
  diskPressure: jest.fn(async () => ({ pressured: false }))
}))
jest.mock('@react-native-community/netinfo', () => {
  const state = { isConnected: true, isInternetReachable: true }
  const api = { fetch: async () => state, refresh: async () => state, addEventListener: () => () => {}, configure: () => {} }
  return { __esModule: true, default: api, ...api, useNetInfo: () => state }
})

import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import {
  arcadeStatus,
  LIVE,
  minerLockingScript,
  minerPrivateKey,
  mineUntilMined,
  sleep,
  rpc,
  spendCoinbase,
  startMiner,
  stopMiner,
  submit,
  until
} from './stack'
import { makeHeadlessWallet, paymentFor, syncHeadersTo, type HeadlessWallet } from './headlessWallet'

const d = LIVE ? describe : describe.skip
jest.setTimeout(900000)

const SEEN = ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES']

/** A: a mined coinbase spend paying the miner key. Returns A with its BUMP, and its output 0 as a funding source. */
async function minedParent(sats: number) {
  const a = await spendCoinbase([{ lockingScript: minerLockingScript, satoshis: sats }])
  const st = await mineUntilMined(a.id('hex'))
  a.merklePath = MerklePath.fromHex(st.merklePath)
  return { a, height: st.blockHeight! }
}

/** B: spends A:0, pays `pay` to the wallet and the change back to the miner key. */
async function childPaying(a: Transaction, h: HeadlessWallet, sats: number, change: number) {
  const pay = paymentFor(h.identityKey)
  const b = new Transaction()
  b.addInput({ sourceTransaction: a, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(minerPrivateKey) })
  b.addOutput({ lockingScript: new P2PKH().lock(pay.pubKeyHash), satoshis: sats })
  b.addOutput({ lockingScript: minerLockingScript, satoshis: change })
  await b.sign()
  return { b, pay }
}

const internalize = (h: HeadlessWallet, b: Transaction, pay: ReturnType<typeof paymentFor>) =>
  h.wallet.internalizeAction({
    tx: b.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: pay.remittance }],
    description: 'zero-conf live'
  })

const balance = async (h: HeadlessWallet) =>
  (await h.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0)

d('live: zero-conf in spv mode', () => {
  beforeAll(() => {
    stopMiner()
  })
  afterAll(() => {
    startMiner()
  })

  it('accepts a payment Arcade has seen, spends it before any block, and verifies both proofs once mined', async () => {
    const h = await makeHeadlessWallet()
    const { a, height } = await minedParent(150_000)
    const { b, pay } = await childPaying(a, h, 100_000, 49_000)
    expect(await submit(b)).toBe(true)
    await until('B seen on the network', async () => SEEN.includes((await arcadeStatus(b.id('hex'))).txStatus ?? ''), {
      timeout: 30000
    })
    await syncHeadersTo(h, height)

    const r = await internalize(h, b, pay)
    expect(r.accepted).toBe(true)
    expect(await balance(h)).toBe(100_000)
    // Not mined, and spendable.
    expect((await arcadeStatus(b.id('hex'))).txStatus).not.toBe('MINED')
    // The toolbox queues the unmined tx for broadcast (`unsent`); the monitor's SendWaiting task sends it
    // once it is 7 s old, which also registers this wallet's callback token with Arcade.
    await sleep(8000)
    await h.sendWaiting()
    const spent = await h.wallet.createAction({
      description: 'zero-conf spend',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()).toHex(),
          satoshis: 5000,
          outputDescription: 'to nobody'
        }
      ],
      options: { acceptDelayedBroadcast: false }
    })
    const cTxid = spent.txid!
    const cStatus = await until('C accepted', async () => {
      const s = (await arcadeStatus(cTxid)).txStatus ?? ''
      return s && s !== 'RECEIVED' ? s : null
    }, { timeout: 30000, every: 500 })
    expect(cStatus).not.toBe('REJECTED')

    // One block mines both. The wallet's chain is behind until it syncs; then polling proves them.
    // (A child of an unmined parent stays ACCEPTED_BY_NETWORK until a block, so wait on B.)
    await mineUntilMined(b.id('hex'))
    // The node takes a child into a block only after its parent has been in one, so it can need another.
    let mined = await arcadeStatus(cTxid)
    for (let i = 0; i < 6 && mined.txStatus !== 'MINED'; i++) {
      await rpc('generate', [1]).catch(() => undefined)
      mined = await until('C mined', async () => {
        const s = await arcadeStatus(cTxid)
        return s.txStatus === 'MINED' ? s : null
      }, { timeout: 15000, every: 1000 }).catch(() => mined)
    }
    expect(mined.txStatus).toBe('MINED')
    await syncHeadersTo(h, mined.blockHeight!)
    await h.checkForProofs()
    // B and C may be in different blocks; each proof must match the wallet's own root for ITS block.
    for (const txid of [b.id('hex'), cTxid]) {
      const rows = await h.rows('SELECT merkleRoot, height FROM proven_txs WHERE txid = ?', [txid])
      expect(rows.length).toBe(1)
      expect(rows[0].height).toBe((await arcadeStatus(txid)).blockHeight)
      expect(rows[0].merkleRoot).toBe(h.store.verifiedRootForHeight(rows[0].height))
    }
  })

  it('refuses a payment whose transaction Arcade has never seen, and stores nothing', async () => {
    const h = await makeHeadlessWallet()
    const { a, height } = await minedParent(150_000)
    const { b, pay } = await childPaying(a, h, 100_000, 49_000)
    // b is never submitted: the sender is handing over a transaction it did not broadcast.
    await syncHeadersTo(h, height)
    const t0 = Date.now()
    await expect(internalize(h, b, pay)).rejects.toThrow(/zero-conf|not seen|unknown/i)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3500)
    expect(await balance(h)).toBe(0)
    expect(await h.rows('SELECT outputId FROM outputs', [])).toEqual([])
    expect(await h.rows('SELECT transactionId FROM transactions', [])).toEqual([])
  })

  it('refuses a payment that conflicts with a transaction already on the network', async () => {
    const h = await makeHeadlessWallet()
    const { a, height } = await minedParent(150_000)
    const first = await childPaying(a, h, 100_000, 49_000)
    expect(await submit(first.b)).toBe(true)
    await until('first seen', async () => SEEN.includes((await arcadeStatus(first.b.id('hex'))).txStatus ?? ''), { timeout: 30000 })
    // A second spend of the same output: Arcade's first-seen rule rejects it.
    const second = await childPaying(a, h, 90_000, 59_000)
    await submit(second.b)
    await until('conflict reported', async () => (await arcadeStatus(second.b.id('hex'))).txStatus === 'REJECTED' || (await arcadeStatus(second.b.id('hex'))).txStatus === 'DOUBLE_SPEND_ATTEMPTED', { timeout: 30000, every: 500 })
    await syncHeadersTo(h, height)
    await expect(internalize(h, second.b, second.pay)).rejects.toThrow(/REJECTED|DOUBLE_SPEND/)
    expect(await balance(h)).toBe(0)
  })
})
