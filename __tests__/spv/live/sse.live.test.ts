/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: Arcade push (SSE) in spv mode, with the toolbox's own ArcadeSSE task, against the
 * regtest stack. Arcade serves SSE from a separate port. Push is a wake-up and a
 * second route to the proof; the proof is stored only through the same verification as
 * polling, and polling alone is enough when push is down. Skipped unless SPV_LIVE=1.
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

import { P2PKH, PrivateKey } from '@bsv/sdk'
import { ARCADE_SSE, LIVE, mineUntilMined, sleep, until } from './stack'
import { fundHeadless, makeHeadlessWallet, syncHeadersTo, type HeadlessWallet } from './headlessWallet'
import { NodeEventSource } from './nodeEventSource'

const d = LIVE ? describe : describe.skip
jest.setTimeout(600000)

const spend = (h: HeadlessWallet, sats: number) =>
  h.wallet.createAction({
    description: 'sse live spend',
    outputs: [
      { lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()).toHex(), satoshis: sats, outputDescription: 'to nobody' }
    ],
    options: { acceptDelayedBroadcast: false }
  })

const provenRows = (h: HeadlessWallet, txid: string) => h.rows('SELECT merkleRoot, height FROM proven_txs WHERE txid = ?', [txid])

d('live: Arcade push (SSE) in spv mode', () => {
  beforeEach(() => {
    NodeEventSource.opened.length = 0
  })

  it('connects to the SSE listener (not the API port) with the callback token and API key, and receives this wallet’s status events', async () => {
    const h = await makeHeadlessWallet({ sseUrl: ARCADE_SSE, arcApiKey: 'sse-live-key' }).catch(e => {
      throw e
    })
    await fundHeadless(h, 60_000)
    await h.startSse()
    expect(NodeEventSource.opened).toHaveLength(1)
    const o = NodeEventSource.opened[0]
    expect(o.url.startsWith(`${ARCADE_SSE}/events?callbackToken=`)).toBe(true)
    expect(decodeURIComponent(o.url.split('callbackToken=')[1])).toBe(h.callbackToken)
    expect(o.headers.Authorization).toBe('Bearer sse-live-key')
    expect(o.headers['Last-Event-ID']).toBeDefined()

    const sent = await spend(h, 3000)
    // Arcade pushes status events for txs submitted with this wallet's token.
    let log = ''
    await until('an SSE event for the spend', async () => {
      log += await h.drainSse()
      return log.includes(`txid=${sent.txid}`)
    }, { timeout: 60000, every: 1000 })
    h.stopSse()
  })

  it('a MINED event before the wallet’s chain reaches the block stores nothing; the replayed event after its own sync stores the verified proof', async () => {
    const h = await makeHeadlessWallet({ sseUrl: ARCADE_SSE })
    await fundHeadless(h, 60_000)
    await h.startSse()
    const sent = await spend(h, 3000)
    const txid = sent.txid!
    const mined = await mineUntilMined(txid)
    expect(h.store.tipHeight).toBeLessThan(mined.blockHeight!)

    let log = ''
    await until('MINED event processed', async () => {
      log += await h.drainSse()
      return log.includes(`txid=${txid} status=MINED`)
    }, { timeout: 60000, every: 1000 })
    // The wallet has not verified that block yet: nothing may be stored.
    expect(await provenRows(h, txid)).toEqual([])
    h.stopSse()

    // Its own chain now holds the block. Reconnect and ask Arcade to replay.
    await syncHeadersTo(h, mined.blockHeight!)
    await h.startSse('0')
    log = ''
    await until('replayed MINED event stores the proof', async () => {
      log += await h.drainSse()
      return (await provenRows(h, txid)).length === 1
    }, { timeout: 60000, every: 1000 })
    const rows = await provenRows(h, txid)
    expect(rows[0].merkleRoot).toBe(h.store.verifiedRootForHeight(mined.blockHeight!))
    h.stopSse()
  })

  it('with the SSE listener unreachable, polling alone still stores the proof', async () => {
    const h = await makeHeadlessWallet({ sseUrl: 'http://127.0.0.1:1' })
    await fundHeadless(h, 60_000)
    await h.startSse().catch(() => undefined)
    const sent = await spend(h, 3000)
    const mined = await mineUntilMined(sent.txid!)
    await syncHeadersTo(h, mined.blockHeight!)
    await sleep(500)
    await h.checkForProofs()
    expect((await provenRows(h, sent.txid!)).length).toBe(1)
    h.stopSse()
  })

  it('with no SSE URL there is no push at all (no connection is opened) and polling still works', async () => {
    const h = await makeHeadlessWallet()
    await fundHeadless(h, 60_000)
    await h.startSse()
    expect(NodeEventSource.opened).toEqual([])
    const sent = await spend(h, 3000)
    const mined = await mineUntilMined(sent.txid!)
    await syncHeadersTo(h, mined.blockHeight!)
    await h.checkForProofs()
    expect((await provenRows(h, sent.txid!)).length).toBe(1)
  })
})
