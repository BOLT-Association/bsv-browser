import { Beef, Transaction } from '@bsv/sdk'
import { arcadeAuthHeaders } from '@bsv/expo-wallet-toolbox/core/spv/arcadeAuth'
import { RawChaintracksClient } from '@bsv/expo-wallet-toolbox/core/spv/rawChaintracksClient'
import { createArcadeMerklePathService } from '@bsv/expo-wallet-toolbox/core/spv/arcadeMerklePath'
import { createArcadeBroadcastService } from '@bsv/expo-wallet-toolbox/core/services/arcadeBroadcastProvider'
import { makeRemoteChaintracks } from '@bsv/expo-wallet-toolbox/core/spv/remoteChaintracks'

const KEY = 'k-1234567890abcdef'
const TXID = 'cd'.repeat(32)

const recorder = (body: unknown = { status: 'success', value: 5 }) => {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: { ...(init?.headers ?? {}) } })
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
  }) as unknown as typeof fetch
  return { fn, seen }
}

describe('arcadeAuthHeaders', () => {
  it('is a Bearer token when there is a key, and nothing when there is not', () => {
    expect(arcadeAuthHeaders(KEY)).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(arcadeAuthHeaders(undefined)).toEqual({})
    expect(arcadeAuthHeaders(null)).toEqual({})
    expect(arcadeAuthHeaders('')).toEqual({})
    expect(arcadeAuthHeaders('   ')).toEqual({})
  })
  it('trims the key', () => {
    expect(arcadeAuthHeaders(`  ${KEY}\n`)).toEqual({ Authorization: `Bearer ${KEY}` })
  })
  it.each(['bad\r\nX-Evil: 1', 'a\u0000b', 'a\u007fb', 'x'.repeat(5000)])('refuses a key that could split or bloat a header (%#)', key => {
    expect(() => arcadeAuthHeaders(key)).toThrow(/API key/)
  })
  it('never puts the key in the error', () => {
    try {
      arcadeAuthHeaders('bad\r\nsecret')
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret')
    }
  })
})

describe('the Arcade API key is sent by every spv Arcade client, and only to its own base', () => {
  it('raw chaintracks client', async () => {
    const { fn, seen } = recorder()
    await new RawChaintracksClient('https://arcade.example.com/chaintracks/v1', fn, KEY).getPresentHeight()
    expect(seen).toHaveLength(1)
    expect(seen[0].url.startsWith('https://arcade.example.com/')).toBe(true)
    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`)
  })
  it('raw chaintracks client without a key sends no Authorization (control)', async () => {
    const { fn, seen } = recorder()
    await new RawChaintracksClient('https://arcade.example.com/chaintracks/v1', fn).getPresentHeight()
    expect(seen[0].headers.Authorization).toBeUndefined()
  })
  it('Arcade proof service', async () => {
    const { fn, seen } = recorder({ txStatus: 'SEEN_ON_NETWORK' })
    await createArcadeMerklePathService('https://arcade.example.com', async () => undefined, fn, KEY)(TXID)
    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`)
  })
  it('broadcast service', async () => {
    const real = globalThis.fetch
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ txid: 'x', txStatus: 'RECEIVED' }),
      headers: { get: () => null }
    })
    globalThis.fetch = fetchMock as never
    try {
      const tx = new Transaction()
      const beef = new Beef()
      beef.mergeTransaction(tx)
      const svc = createArcadeBroadcastService('https://arcade.example.com', 'tok', KEY)
      await svc.service(beef, [tx.id('hex')])
    } finally {
      globalThis.fetch = real
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://arcade.example.com/tx')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(init.headers['X-CallbackToken']).toBe('tok')
  })
  it('broadcast service without a key sends no Authorization (control)', async () => {
    const real = globalThis.fetch
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ txid: 'x', txStatus: 'RECEIVED' }), headers: { get: () => null } })
    globalThis.fetch = fetchMock as never
    try {
      const tx = new Transaction()
      const beef = new Beef()
      beef.mergeTransaction(tx)
      await createArcadeBroadcastService('https://arcade.example.com', 'tok').service(beef, [tx.id('hex')])
    } finally {
      globalThis.fetch = real
    }
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })
  it('makeRemoteChaintracks passes the key to the raw client', async () => {
    const { fn, seen } = recorder()
    const real = globalThis.fetch
    globalThis.fetch = fn
    try {
      const c = makeRemoteChaintracks('ttn', 'https://arcade.example.com/chaintracks/v1', { rules: 'regtest' }, KEY) as unknown as {
        getPresentHeight(): Promise<number>
      }
      await c.getPresentHeight()
    } finally {
      globalThis.fetch = real
    }
    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`)
  })
})
