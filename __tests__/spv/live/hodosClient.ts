/**
 * HTTP client for a running Hodos wallet (the Rust `hodos-wallet` process) in spv mode, for the
 * cross-wallet live test. Calls carry no X-Requesting-Domain header, so they are the wallet's
 * internal calls (no permission prompts), exactly as tests/hodos-spv/lib.mjs makes them.
 *
 * The wallet must already be running on a scratch data directory (ChainBrowsers docs/hodos-spv.md):
 * HODOS_DEV=1, HODOS_DATA_DIR, HODOS_CHAIN_MODE=spv, HODOS_ARCADE_URL, HODOS_CHAINTRACKS_URL.
 */
import { Beef, MerklePath, P2PKH, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { mineUntilMined, nodeFetch, spendCoinbase, until } from './stack'

export const HODOS = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
/** BRC-29 payment protocol, as both wallets derive it. */
export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8']

export interface Remittance {
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
}

const rnd = () => Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
/** A fresh BRC-29 derivation prefix and suffix. */
export const newDerivation = () => ({ derivationPrefix: rnd(), derivationSuffix: rnd() })

async function call(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await nodeFetch(HODOS + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

export async function hodosUp(): Promise<boolean> {
  try {
    return (await call('/health')).status === 200
  } catch {
    return false
  }
}

export async function hodosIdentityKey(): Promise<string> {
  const r = await call('/getPublicKey', { identityKey: true })
  if (!r.json.publicKey) throw new Error('Hodos has no identity key (create the wallet first): ' + JSON.stringify(r))
  return r.json.publicKey
}

/** The key Hodos derives for a BRC-29 payment TO `counterparty` (the recipient's identity key). */
export async function hodosPaymentKeyFor(counterparty: string, d: { derivationPrefix: string; derivationSuffix: string }): Promise<string> {
  const r = await call('/getPublicKey', {
    protocolID: BRC29_PROTOCOL,
    keyID: `${d.derivationPrefix} ${d.derivationSuffix}`,
    counterparty
  })
  if (!r.json.publicKey) throw new Error('Hodos getPublicKey failed: ' + JSON.stringify(r))
  return r.json.publicKey
}

/** Hodos builds, signs and broadcasts (through Arcade) a transaction; returns its txid and Atomic BEEF. */
export async function hodosCreateAction(args: unknown): Promise<{ txid: string; tx: number[] }> {
  const r = await call('/createAction', args)
  if (r.status !== 200 || !r.json.txid || !r.json.tx) throw new Error(`Hodos createAction ${r.status}: ${JSON.stringify(r.json).slice(0, 400)}`)
  return { txid: r.json.txid, tx: r.json.tx }
}

export const hodosInternalize = (tx: number[], outputIndex: number, remittance: Remittance, description: string) =>
  call('/internalizeAction', {
    tx,
    outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: remittance }],
    description
  })

export const hodosBalance = async (): Promise<number> => (await call('/wallet/balance')).json.balance

export async function hodosActivity(txid: string): Promise<any | undefined> {
  const j = (await call('/wallet/activity')).json
  return (j.items ?? []).find((x: any) => x.txid === txid)
}

/** Wait until Hodos's own verified header chain holds `height` (it syncs every 30 s). */
export async function hodosWaitForHeader(height: number, timeout = 120000): Promise<void> {
  await until(`Hodos header chain reaches ${height}`, async () => (await call('/getHeaderForHeight', { height })).status === 200, {
    timeout,
    every: 2000
  })
}

/** Fund Hodos with a mined coinbase spend, internalized as an Atomic BEEF (port of tests/hodos-spv/lib.mjs). */
export async function fundHodos(satoshis: number): Promise<{ txid: string; height: number }> {
  const walletPub = PublicKey.fromString(await hodosIdentityKey())
  const sender = PrivateKey.fromRandom()
  const d = newDerivation()
  const childPub = walletPub.deriveChild(sender, `2-3241645161d8-${d.derivationPrefix} ${d.derivationSuffix}`)
  const tx = await spendCoinbase([{ lockingScript: new P2PKH().lock(childPub.toHash() as number[]), satoshis }])
  const st = await mineUntilMined(tx.id('hex'))
  tx.merklePath = MerklePath.fromHex(st.merklePath)
  await hodosWaitForHeader(st.blockHeight!)
  const r = await hodosInternalize(tx.toAtomicBEEF(), 0, { senderIdentityKey: sender.toPublicKey().toString(), ...d }, 'cross-wallet funding')
  if (r.status !== 200) throw new Error(`Hodos refused its funding: ${r.status} ${JSON.stringify(r.json)}`)
  return { txid: tx.id('hex'), height: st.blockHeight! }
}

/** The same Atomic BEEF with one sibling hash of its first BUMP changed (the proof no longer matches any block). */
export function tamperBump(atomic: number[], txid: string): number[] {
  const beef = Beef.fromBinary(atomic)
  for (const bump of beef.bumps) {
    for (const level of bump.path) {
      const sib = level.find(l => l.hash && !l.txid)
      if (sib) {
        sib.hash = 'ab'.repeat(32)
        return beef.toBinaryAtomic(txid)
      }
    }
  }
  throw new Error('the BEEF has no BUMP sibling to tamper with')
}
