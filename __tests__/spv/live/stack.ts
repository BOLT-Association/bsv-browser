/**
 * Helpers for the live tests, which run against the spv-testnet regtest stack.
 *
 * The wallet code under test talks ONLY to Arcade (API, chaintracks). Teranode
 * RPC is used here, by the harness, to mine and to force reorgs, exactly as the
 * Hodos harness (tests/hodos-spv/lib.mjs) does; nothing under test calls it.
 */
import { execFileSync } from 'node:child_process'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

export const LIVE = process.env.SPV_LIVE === '1'
export const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
export const CHAINTRACKS = process.env.CHAINTRACKS_URL ?? 'http://localhost:8083/chaintracks/v1'
export const ARCADE_SSE = process.env.ARCADE_SSE_URL ?? 'http://localhost:8082'
export const RPC_URL = process.env.RPC_URL ?? 'http://localhost:29292'
/** Bitcoin regtest genesis, the trust anchor of the regtest header window. */
export const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'

/** The real Node fetch, provided by nodeEnv.cjs (jest-expo's global fetch cannot reach localhost). */
export const nodeFetch: typeof fetch = (globalThis as unknown as { __nodeFetch: typeof fetch }).__nodeFetch

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await nodeFetch(RPC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from('bitcoin:bitcoin').toString('base64')
    },
    body: JSON.stringify({ method, params })
  })
  const j = (await r.json()) as { error?: unknown; result?: unknown }
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

export async function until<T>(
  label: string,
  fn: () => Promise<T | false | undefined | null>,
  { timeout = 60000, every = 1000 } = {}
): Promise<T> {
  const end = Date.now() + timeout
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(every)
  }
  throw new Error(`timeout waiting for ${label}${last ? ': ' + (last as Error).message : ''}`)
}

/** `generate` can pass Teranode's 30 s RPC timeout while block assembly resets; the blocks still arrive. */
export async function mine(n: number): Promise<void> {
  const start = (await rpc('getinfo')).blocks as number
  try {
    await rpc('generate', [n])
  } catch (e) {
    if (!/timed out/.test((e as Error).message)) throw e
    await until(`height ${start + n}`, async () => ((await rpc('getinfo')).blocks as number) >= start + n, {
      timeout: 180000,
      every: 2000
    })
  }
}

export const height = async (): Promise<number> => (await rpc('getinfo')).blocks

/** The stack's miner mines every few seconds, so a test that needs control of the chain stops it first. */
export function stopMiner(): void {
  execFileSync('docker', ['stop', 'cb-block-generator'], { stdio: 'ignore' })
}
export function startMiner(): void {
  execFileSync('docker', ['start', 'cb-block-generator'], { stdio: 'ignore' })
}

/** A header as chaintracks itself reports it (the test's independent view, not the wallet's). */
export async function chaintracksHeader(height: number): Promise<{ hash: string; merkleRoot: string } | undefined> {
  const r = await nodeFetch(`${CHAINTRACKS}/findHeaderHexForHeight?height=${height}`)
  if (!r.ok) return undefined
  const j = (await r.json()) as { status?: string; value?: { hash: string; merkleRoot: string } | null }
  return j.status === 'success' && j.value ? j.value : undefined
}

// ── Arcade + coinbase helpers (ported from tests/hodos-spv/lib.mjs) ─────────────────────────
// Public regtest key from Teranode's settings.conf (PK1): the node's coinbase pays this key.
const MINER_WIF = process.env.MINER_WIF ?? 'L56TgyTpDdvL3W24SMoALYotibToSCySQeo4pThLKxw6EFR6f93Q'
const minerKey = PrivateKey.fromWif(MINER_WIF)
const minerScript = new P2PKH().lock(minerKey.toPublicKey().toHash())
export const minerLockingScript = minerScript
export const minerPrivateKey = minerKey

export interface ArcadeStatus {
  txid?: string
  txStatus?: string
  blockHeight?: number
  blockHash?: string
  merklePath?: string
}

export async function arcadeStatus(txid: string): Promise<ArcadeStatus> {
  return (await nodeFetch(`${ARCADE}/tx/${txid}`)).json() as Promise<ArcadeStatus>
}

/** Submit a signed tx (source txs attached) to Arcade as Extended Format. */
export async function submit(tx: Transaction): Promise<boolean> {
  const res = await nodeFetch(`${ARCADE}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: tx.toHexEF() })
  return res.status === 202
}

/**
 * Spend a random mature coinbase into `outputs` (the remainder returns to the miner key), retrying
 * until the NETWORK, not just Arcade, takes one: a coinbase an earlier run already spent is
 * accepted for processing and rejected a moment later.
 */
export async function spendCoinbase(outputs: { lockingScript: any; satoshis: number }[]): Promise<Transaction> {
  const tip = await height()
  const total = outputs.reduce((a, o) => a + o.satoshis, 0)
  for (let k = 0; k < 40; k++) {
    try {
      const h = tip - 100 - Math.floor(Math.random() * 60)
      const block = await rpc('getblock', [await rpc('getblockhash', [h]), 1])
      const cbHex = await rpc('getrawtransaction', [block.tx?.[0] ?? block.merkleroot, 0])
      const source = Transaction.fromHex(cbHex)
      const vout = source.outputs.findIndex(o => o.lockingScript.toHex() === minerScript.toHex())
      if (vout < 0) continue
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(minerKey) })
      for (const o of outputs) tx.addOutput(o)
      tx.addOutput({ lockingScript: minerScript, satoshis: source.outputs[vout].satoshis! - total })
      await tx.sign()
      if (await submit(tx)) {
        const verdict = await until(
          'network verdict',
          async () => {
            const st = (await arcadeStatus(tx.id('hex'))).txStatus ?? ''
            return ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED', 'REJECTED', 'DOUBLE_SPEND_ATTEMPTED'].includes(st) ? st : null
          },
          { timeout: 20000, every: 500 }
        ).catch(() => 'UNKNOWN')
        if (!['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'UNKNOWN'].includes(verdict)) return tx
      }
    } catch {
      // try another coinbase
    }
  }
  throw new Error('no usable coinbase')
}

/** Mine until Arcade reports the tx MINED with a BUMP; returns Arcade's status object. */
export async function mineUntilMined(txid: string): Promise<ArcadeStatus & { merklePath: string }> {
  await until(
    'SEEN_ON_NETWORK',
    async () => ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED'].includes((await arcadeStatus(txid)).txStatus ?? ''),
    { timeout: 30000 }
  )
  await sleep(3000)
  for (let i = 0; i < 6; i++) {
    await rpc('generate', [1]).catch(() => {})
    const st = await until(
      'MINED',
      async () => {
        const s = await arcadeStatus(txid)
        return s.txStatus === 'MINED' && s.merklePath ? (s as ArcadeStatus & { merklePath: string }) : null
      },
      { timeout: 30000, every: 2000 }
    ).catch(() => null)
    if (st) return st
  }
  throw new Error('tx never mined')
}

export { MerklePath }
