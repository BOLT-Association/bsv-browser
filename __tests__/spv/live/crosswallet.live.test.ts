/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: two different wallets paying each other in spv mode. One is this repo's wallet
 * (headless), the other a running Hodos wallet (Rust, driven over its HTTP API). Both use
 * only the local Arcade; each verifies the other's payment against its own header chain.
 *
 * A payment is BRC-29: the sender derives the recipient's key (getPublicKey with the
 * recipient's identity key as counterparty), pays it with createAction and broadcasts
 * through Arcade; the test carries the Atomic BEEF and the derivation data across, and
 * the recipient takes it with internalizeAction. The stack's miner is stopped, so each
 * payment is unmined when received and mined by hand afterwards.
 *
 * Needs a Hodos wallet in spv mode on a scratch data directory (WALLET_URL, default
 * http://127.0.0.1:31401; see ChainBrowsers docs/hodos-spv.md). Skipped unless SPV_LIVE=1 and
 * SPV_HODOS=1 (so a run of the whole live directory does not need a Hodos wallet).
 *
 *   SPV_LIVE=1 SPV_HODOS=1 npx jest __tests__/spv/live/crosswallet --runInBand
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

import { execFileSync } from 'node:child_process'
import { P2PKH, PublicKey } from '@bsv/sdk'
import { arcadeStatus, LIVE, mineUntilMined, sleep, startMiner, stopMiner, until } from './stack'
import { fundHeadless, makeHeadlessWallet, syncHeadersTo, type HeadlessWallet } from './headlessWallet'
import {
  BRC29_PROTOCOL,
  fundHodos,
  HODOS,
  hodosActivity,
  hodosBalance,
  hodosCreateAction,
  hodosIdentityKey,
  hodosInternalize,
  hodosPaymentKeyFor,
  hodosUp,
  hodosWaitForHeader,
  newDerivation,
  tamperBump
} from './hodosClient'

const d = LIVE && process.env.SPV_HODOS === '1' ? describe : describe.skip
jest.setTimeout(900000)

const FUND = 200_000
const PAY = 30_000
const SEEN = ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES']

const p2pkhHex = (pubKeyHex: string) => new P2PKH().lock(PublicKey.fromString(pubKeyHex).toHash() as number[]).toHex()
const balance = async (h: HeadlessWallet) =>
  (await h.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0)
const seenByArcade = (txid: string) =>
  until(`${txid.slice(0, 12)} seen on the network`, async () => SEEN.includes((await arcadeStatus(txid)).txStatus ?? ''), { timeout: 30000, every: 500 })
const minerRunning = () =>
  execFileSync('docker', ['ps', '--filter', 'name=cb-block-generator', '--format', '{{.Names}}']).toString().includes('cb-block-generator')

d('live: Hodos and this wallet pay each other in spv mode', () => {
  let h: HeadlessWallet
  let hodosId: string
  let minerWasRunning = false
  let hodosFundHeight = 0
  let headlessFundHeight = 0
  let firstPaymentHeight = 0

  beforeAll(async () => {
    if (!(await hodosUp())) throw new Error(`no Hodos wallet at ${HODOS}: start one in spv mode on a scratch data directory first`)
    minerWasRunning = minerRunning()
    if (minerWasRunning) stopMiner()
    h = await makeHeadlessWallet()
    hodosId = await hodosIdentityKey()
  })
  afterAll(() => {
    if (minerWasRunning) startMiner()
  })

  it('funds each wallet from the chain', async () => {
    const before = await hodosBalance()
    hodosFundHeight = (await fundHodos(FUND)).height
    expect((await hodosBalance()) - before).toBe(FUND)

    headlessFundHeight = (await fundHeadless(h, FUND)).height
    expect(await balance(h)).toBe(FUND)
  })

  it('Hodos pays this wallet: refused with a wrong proof or wrong derivation, accepted unmined, proven by both once mined', async () => {
    const deriv = newDerivation()
    const key = await hodosPaymentKeyFor(h.identityKey, deriv)
    const sent = await hodosCreateAction({
      description: 'cross-wallet: Hodos pays bsv-browser',
      outputs: [{ satoshis: PAY, lockingScript: p2pkhHex(key), outputDescription: 'BRC-29 payment' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    await seenByArcade(sent.txid)
    expect((await arcadeStatus(sent.txid)).txStatus).not.toBe('MINED')
    // The BEEF's proofs are for Hodos's funding block; this wallet must hold that header itself.
    await syncHeadersTo(h, hodosFundHeight)

    const remittance = { senderIdentityKey: hodosId, ...deriv }
    const args = (tx: number[], r = remittance) => ({
      tx,
      outputs: [{ outputIndex: 0, protocol: 'wallet payment' as const, paymentRemittance: r }],
      description: 'cross-wallet: from Hodos'
    })
    const before = await balance(h)

    await expect(h.wallet.internalizeAction(args(tamperBump(sent.tx, sent.txid)))).rejects.toThrow()
    await expect(h.wallet.internalizeAction(args(sent.tx, { ...remittance, derivationSuffix: newDerivation().derivationSuffix }))).rejects.toThrow()
    expect(await balance(h)).toBe(before)

    const r = await h.wallet.internalizeAction(args(sent.tx))
    expect(r.accepted).toBe(true)
    expect(await balance(h)).toBe(before + PAY)

    // One block; each wallet then proves the tx against its own header chain.
    const st = await mineUntilMined(sent.txid)
    firstPaymentHeight = st.blockHeight!
    await syncHeadersTo(h, st.blockHeight!)
    await sleep(8000)
    await h.sendWaiting()
    await h.checkForProofs()
    const rows = await h.rows('SELECT merkleRoot, height FROM proven_txs WHERE txid = ?', [sent.txid])
    expect(rows.length).toBe(1)
    expect(rows[0].height).toBe(st.blockHeight)
    expect(rows[0].merkleRoot).toBe(h.store.verifiedRootForHeight(rows[0].height))
    await until('Hodos marks its payment completed', async () => (await hodosActivity(sent.txid))?.status === 'completed', {
      timeout: 200000,
      every: 3000
    })
  })

  it('this wallet pays Hodos: refused with a wrong proof or wrong derivation, accepted unmined, proven by both once mined', async () => {
    const deriv = newDerivation()
    const { publicKey } = await h.wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${deriv.derivationPrefix} ${deriv.derivationSuffix}`,
      counterparty: hodosId
    })
    const sent = await h.wallet.createAction({
      description: 'cross-wallet: bsv-browser pays Hodos',
      outputs: [{ satoshis: PAY, lockingScript: p2pkhHex(publicKey), outputDescription: 'BRC-29 payment' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const txid = sent.txid!
    const tx = sent.tx as number[]
    await seenByArcade(txid)
    expect((await arcadeStatus(txid)).txStatus).not.toBe('MINED')
    // Hodos must hold the headers for the proofs in the BEEF (this wallet's funding and the previous payment).
    await hodosWaitForHeader(Math.max(headlessFundHeight, firstPaymentHeight))

    const remittance = { senderIdentityKey: h.identityKey, ...deriv }
    const before = await hodosBalance()

    const tampered = await hodosInternalize(tamperBump(tx, txid), 0, remittance, 'cross-wallet: tampered')
    expect(tampered.status).toBe(400)
    expect(JSON.stringify(tampered.json)).toMatch(/ERR_PROOF_NOT_VERIFIED/)
    const wrong = await hodosInternalize(tx, 0, { ...remittance, derivationSuffix: newDerivation().derivationSuffix }, 'cross-wallet: wrong derivation')
    expect(wrong.status).not.toBe(200)
    expect(await hodosBalance()).toBe(before)

    const ok = await hodosInternalize(tx, 0, remittance, 'cross-wallet: from bsv-browser')
    expect(ok.status).toBe(200)
    expect((await hodosBalance()) - before).toBe(PAY)

    const st = await mineUntilMined(txid)
    await syncHeadersTo(h, st.blockHeight!)
    await h.checkForProofs()
    const rows = await h.rows('SELECT merkleRoot, height FROM proven_txs WHERE txid = ?', [txid])
    expect(rows.length).toBe(1)
    expect(rows[0].merkleRoot).toBe(h.store.verifiedRootForHeight(rows[0].height))
    await until('Hodos marks the received payment completed', async () => (await hodosActivity(txid))?.status === 'completed', {
      timeout: 200000,
      every: 3000
    })
  })
})
