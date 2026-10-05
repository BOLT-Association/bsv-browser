import { Beef, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { guardZeroConfInternalize } from '@bsv/expo-wallet-toolbox/core/spv/zeroConf'

const ARC = 'https://arcade.example.com'
const key = PrivateKey.fromRandom()

/** A (mined, has a BUMP) and B (spends A, no BUMP): the BEEF of an unmined payment. */
async function unminedBeef() {
  const a = new Transaction()
  a.addOutput({ lockingScript: new P2PKH().lock(key.toPublicKey().toHash()), satoshis: 10_000 })
  a.merklePath = new MerklePath(5, [[{ offset: 0, hash: a.id('hex'), txid: true }, { offset: 1, hash: 'ab'.repeat(32) }]])
  const b = new Transaction()
  b.addInput({ sourceTransaction: a, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  b.addOutput({ lockingScript: new P2PKH().lock(key.toPublicKey().toHash()), satoshis: 9_000 })
  await b.sign()
  return { beef: b.toAtomicBEEF() as number[], aTxid: a.id('hex'), bTxid: b.id('hex') }
}

/** A fully proven BEEF: nothing to check. */
function provenBeef() {
  const a = new Transaction()
  a.addOutput({ lockingScript: new P2PKH().lock(key.toPublicKey().toHash()), satoshis: 10_000 })
  a.merklePath = new MerklePath(5, [[{ offset: 0, hash: a.id('hex'), txid: true }, { offset: 1, hash: 'ab'.repeat(32) }]])
  return a.toAtomicBEEF() as number[]
}

type Step = { status: number; txStatus?: string }
/** Arcade stand-in: answers /tx/{txid} from a per-txid script, repeating the last step. */
function arcade(script: Record<string, Step[]>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const idx: Record<string, number> = {}
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } })
    const txid = url.split('/tx/')[1]
    const steps = script[txid] ?? [{ status: 404 }]
    const i = Math.min(idx[txid] ?? 0, steps.length - 1)
    idx[txid] = (idx[txid] ?? 0) + 1
    const s = steps[i]
    return {
      ok: s.status >= 200 && s.status < 300,
      status: s.status,
      json: async () => ({ txid, txStatus: s.txStatus })
    } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const run = async (
  script: Record<string, Step[]>,
  beef: number[],
  opts: { waitMs?: number; apiKey?: string } = {}
) => {
  const { fn, calls } = arcade(script)
  const inner = jest.fn(async (args: { tx: number[] }) => ({ accepted: true, echoed: args.tx.length }))
  const guarded = guardZeroConfInternalize(inner as never, {
    arcUrl: ARC,
    fetcher: fn,
    waitMs: opts.waitMs ?? 300,
    pollMs: 20,
    apiKey: opts.apiKey
  })
  const result = await guarded({ tx: beef, outputs: [], description: 'x' } as never).catch((e: Error) => e)
  return { result, inner, calls }
}

describe('guardZeroConfInternalize', () => {
  it('passes a fully proven BEEF straight through, asking Arcade nothing', async () => {
    const { result, inner, calls } = await run({}, provenBeef())
    expect(inner).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
    expect((result as any).accepted).toBe(true)
  })

  it('accepts an unmined subject once Arcade has seen it on the network', async () => {
    const { beef, bTxid } = await unminedBeef()
    for (const txStatus of ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'SEEN_MULTIPLE_NODES', 'MINED', 'IMMUTABLE']) {
      const { result, inner, calls } = await run({ [bTxid]: [{ status: 200, txStatus }] }, beef)
      expect(inner).toHaveBeenCalledTimes(1)
      expect((result as any).accepted).toBe(true)
      expect(calls.every(c => c.url === `${ARC}/tx/${bTxid}`)).toBe(true)
    }
  })

  it('asks about the unmined tx only, not the mined parent', async () => {
    const { beef, bTxid, aTxid } = await unminedBeef()
    const { calls } = await run({ [bTxid]: [{ status: 200, txStatus: 'SEEN_ON_NETWORK' }] }, beef)
    expect(calls.map(c => c.url)).toEqual([`${ARC}/tx/${bTxid}`])
    expect(calls.some(c => c.url.includes(aTxid))).toBe(false)
  })

  it('waits for a tx Arcade is still processing, and accepts when it becomes seen', async () => {
    const { beef, bTxid } = await unminedBeef()
    const { result, inner } = await run(
      { [bTxid]: [{ status: 404 }, { status: 200, txStatus: 'RECEIVED' }, { status: 200, txStatus: 'SEEN_ON_NETWORK' }] },
      beef
    )
    expect(inner).toHaveBeenCalledTimes(1)
    expect((result as any).accepted).toBe(true)
  })

  it.each([
    ['unknown to Arcade', [{ status: 404 }]],
    ['stuck below seen (ACCEPTED_BY_NETWORK)', [{ status: 200, txStatus: 'ACCEPTED_BY_NETWORK' }]],
    ['only RECEIVED', [{ status: 200, txStatus: 'RECEIVED' }]],
    ['Arcade erroring', [{ status: 500 }]]
  ] as [string, Step[]][])('refuses an unmined subject that is %s, after waiting, without calling the wallet', async (_n, steps) => {
    const { beef, bTxid } = await unminedBeef()
    const t0 = Date.now()
    const { result, inner } = await run({ [bTxid]: steps }, beef)
    expect(inner).not.toHaveBeenCalled()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/not .*seen|network/i)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
  })

  it.each(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'])(
    'refuses at once when Arcade reports %s',
    async txStatus => {
      const { beef, bTxid } = await unminedBeef()
      const t0 = Date.now()
      const { result, inner } = await run({ [bTxid]: [{ status: 200, txStatus }] }, beef, { waitMs: 5000 })
      expect(inner).not.toHaveBeenCalled()
      expect((result as Error).message).toContain(txStatus)
      expect(Date.now() - t0).toBeLessThan(2000)
    }
  )

  it('sends the Arcade API key, and never anywhere but Arcade', async () => {
    const { beef, bTxid } = await unminedBeef()
    const { calls } = await run({ [bTxid]: [{ status: 200, txStatus: 'SEEN_ON_NETWORK' }] }, beef, { apiKey: 'zc-key' })
    expect(calls[0].headers.Authorization).toBe('Bearer zc-key')
    expect(calls.every(c => c.url.startsWith(`${ARC}/`))).toBe(true)
  })

  it('leaves input it cannot read to the wallet, which rejects it itself (no Arcade call)', async () => {
    const { result, inner, calls } = await run({}, [1, 2, 3])
    expect(calls).toEqual([])
    expect(inner).toHaveBeenCalledTimes(1)
    expect((result as any).accepted).toBe(true)
  })

  it('passes the original arguments through unchanged', async () => {
    const { beef, bTxid } = await unminedBeef()
    const { fn } = arcade({ [bTxid]: [{ status: 200, txStatus: 'SEEN_ON_NETWORK' }] })
    const inner = jest.fn(async () => ({ accepted: true }))
    const args = { tx: beef, outputs: [{ outputIndex: 0 }], description: 'desc' } as never
    await guardZeroConfInternalize(inner as never, { arcUrl: ARC, fetcher: fn, waitMs: 100, pollMs: 10 })(args)
    expect(inner).toHaveBeenCalledWith(args, undefined)
    expect(Beef.fromBinary(beef).txs.length).toBe(2)
  })
})
