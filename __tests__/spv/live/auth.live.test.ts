/**
 * @jest-environment <rootDir>/__tests__/spv/live/nodeEnv.cjs
 *
 * LIVE: an Arcade that requires an API key. The stack's Arcade has none, so two small
 * reverse proxies stand in front of it and answer 401 unless the request carries
 * `Authorization: Bearer <key>`. Skipped unless SPV_LIVE=1.
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

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { MerklePath, P2PKH, PrivateKey } from '@bsv/sdk'
import { ARCADE, CHAINTRACKS, LIVE, mineUntilMined, spendCoinbase } from './stack'
import { makeHeadlessWallet, paymentFor } from './headlessWallet'

const d = LIVE ? describe : describe.skip
jest.setTimeout(600000)

const KEY = 'live-arcade-key-0123456789'

interface Gate {
  url: string
  stats: { ok: number; unauthorised: number }
  close(): Promise<void>
}

/** A reverse proxy to `target` (its path is kept) that requires the API key. */
async function gate(target: string): Promise<Gate> {
  const t = new URL(target)
  const stats = { ok: 0, unauthorised: 0 }
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      stats.unauthorised++
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorised' }))
      return
    }
    stats.ok++
    const up = http.request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } },
      r => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      }
    )
    up.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}${t.pathname === '/' ? '' : t.pathname}`,
    stats,
    close: () => new Promise<void>(r => server.close(() => r()))
  }
}

d('live: Arcade that requires an API key', () => {
  let arc: Gate
  let ct: Gate
  beforeAll(async () => {
    arc = await gate(ARCADE)
    ct = await gate(CHAINTRACKS)
  })
  afterAll(async () => {
    await arc.close()
    await ct.close()
  })

  it('a wallet with no key cannot sync headers (the failure is an error, not an empty chain)', async () => {
    const h = await makeHeadlessWallet({ arcUrl: arc.url, chaintracksUrl: ct.url })
    await expect(h.syncHeaders()).rejects.toThrow(/401/)
    expect(h.store.tipHeight).toBe(0)
    expect(ct.stats.ok).toBe(0)
  })

  it('a wallet with the key syncs, funds by BEEF, spends through Arcade and verifies the proof; every request carried the key', async () => {
    const okBefore = { arc: arc.stats.ok, ct: ct.stats.ok }
    const unauthBefore = { arc: arc.stats.unauthorised, ct: ct.stats.unauthorised }
    const h = await makeHeadlessWallet({ arcUrl: arc.url, chaintracksUrl: ct.url, arcApiKey: KEY })

    const pay = paymentFor(h.identityKey)
    const tx = await spendCoinbase([{ lockingScript: new P2PKH().lock(pay.pubKeyHash), satoshis: 50_000 }])
    const st = await mineUntilMined(tx.id('hex'))
    tx.merklePath = MerklePath.fromHex(st.merklePath)
    for (let i = 0; i < 30 && h.store.tipHeight < st.blockHeight!; i++) {
      await h.syncHeaders()
      if (h.store.tipHeight < st.blockHeight!) await new Promise(r => setTimeout(r, 2000))
    }
    expect(h.store.tipHeight).toBeGreaterThanOrEqual(st.blockHeight!)

    const r = await h.wallet.internalizeAction({
      tx: tx.toAtomicBEEF(),
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: pay.remittance }],
      description: 'auth live funding'
    })
    expect(r.accepted).toBe(true)

    const dest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()).toHex()
    const sent = await h.wallet.createAction({
      description: 'auth live spend',
      outputs: [{ lockingScript: dest, satoshis: 3000, outputDescription: 'to nobody' }],
      options: { acceptDelayedBroadcast: false }
    })
    const mined = await mineUntilMined(sent.txid!)
    for (let i = 0; i < 30 && h.store.tipHeight < mined.blockHeight!; i++) {
      await h.syncHeaders()
      if (h.store.tipHeight < mined.blockHeight!) await new Promise(r => setTimeout(r, 2000))
    }
    await h.checkForProofs()
    const proven = await h.rows('SELECT merkleRoot FROM proven_txs WHERE txid = ?', [sent.txid])
    expect(proven.length).toBe(1)

    // Arcade (broadcast + proof) and chaintracks (headers) were both used, always with the key.
    expect(arc.stats.ok - okBefore.arc).toBeGreaterThanOrEqual(2)
    expect(ct.stats.ok - okBefore.ct).toBeGreaterThanOrEqual(1)
    expect(arc.stats.unauthorised - unauthBefore.arc).toBe(0)
    expect(ct.stats.unauthorised - unauthBefore.ct).toBe(0)
  })
})
