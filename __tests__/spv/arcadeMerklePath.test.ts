import { createArcadeMerklePathService } from '@bsv/expo-wallet-toolbox/core/spv/arcadeMerklePath'
import { MerklePath } from '@bsv/sdk'

const ARC = 'http://192.168.1.20:8080'
const TXID = 'cd'.repeat(32)

// A minimal two-leaf BUMP for TXID at height 7.
const mp = new MerklePath(7, [[{ offset: 0, hash: TXID, txid: true }, { offset: 1, hash: 'ef'.repeat(32) }]])
const MP_HEX = mp.toHex()
const HEADER = { height: 7, hash: 'aa'.repeat(32), merkleRoot: mp.computeRoot(TXID), version: 1, previousHash: '00'.repeat(32), time: 1, bits: 0x207fffff, nonce: 0 }

function fetchOf(status: number, body: unknown) {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('createArcadeMerklePathService', () => {
  it('returns the BUMP Arcade reports with the VERIFIED header for its height', async () => {
    const { fn, calls } = fetchOf(200, { txStatus: 'MINED', blockHeight: 7, merklePath: MP_HEX })
    const getHeader = jest.fn(async () => HEADER)
    const r = await createArcadeMerklePathService(ARC, getHeader as never, fn)(TXID)
    expect(calls).toEqual([`${ARC}/tx/${TXID}`])
    expect(getHeader).toHaveBeenCalledWith(7)
    expect(r.name).toBe('Arcade')
    expect(r.merklePath?.blockHeight).toBe(7)
    expect(r.header).toEqual(HEADER)
    expect(r.error).toBeUndefined()
  })

  it('no BUMP yet is not an error and not a proof', async () => {
    const { fn } = fetchOf(200, { txStatus: 'SEEN_ON_NETWORK' })
    const getHeader = jest.fn()
    const r = await createArcadeMerklePathService(ARC, getHeader as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(getHeader).not.toHaveBeenCalled()
  })

  it('an unknown tx (404) is not a proof', async () => {
    const { fn } = fetchOf(404, { error: 'not found' })
    const r = await createArcadeMerklePathService(ARC, jest.fn() as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
  })

  it('a height the verified chain does not hold yet yields an error and NO proof (so it is retried, never stored)', async () => {
    const { fn } = fetchOf(200, { txStatus: 'MINED', blockHeight: 7, merklePath: MP_HEX })
    const getHeader = jest.fn(async () => {
      throw new Error('height 7 is not in the verified header chain')
    })
    const r = await createArcadeMerklePathService(ARC, getHeader as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
    expect(r.header).toBeUndefined()
    expect(r.error?.message).toMatch(/verified/)
  })

  it('refuses a BUMP that does not contain the txid', async () => {
    const other = new MerklePath(7, [[{ offset: 0, hash: 'ab'.repeat(32), txid: true }, { offset: 1, hash: 'ef'.repeat(32) }]])
    const { fn } = fetchOf(200, { txStatus: 'MINED', blockHeight: 7, merklePath: other.toHex() })
    const r = await createArcadeMerklePathService(ARC, jest.fn(async () => HEADER) as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
    expect(r.error).toBeDefined()
  })

  it('refuses a BUMP whose height disagrees with the height Arcade reports', async () => {
    const { fn } = fetchOf(200, { txStatus: 'MINED', blockHeight: 9, merklePath: MP_HEX })
    const r = await createArcadeMerklePathService(ARC, jest.fn(async () => HEADER) as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
    expect(r.error).toBeDefined()
  })

  it('refuses a malformed BUMP', async () => {
    const { fn } = fetchOf(200, { txStatus: 'MINED', blockHeight: 7, merklePath: 'zz' })
    const r = await createArcadeMerklePathService(ARC, jest.fn() as never, fn)(TXID)
    expect(r.merklePath).toBeUndefined()
    expect(r.error).toBeDefined()
  })

  it('refuses a txid that is not 64 hex characters before making any request', async () => {
    const { fn, calls } = fetchOf(200, {})
    await expect(createArcadeMerklePathService(ARC, jest.fn() as never, fn)('../etc')).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('arcadeMerklePathOverride', () => {
  const { arcadeMerklePathOverride } = require('@bsv/expo-wallet-toolbox/core/spv/arcadeMerklePath')
  const tracker = { findHeaderForHeight: async () => undefined }
  it('is used only for regtest rules', () => {
    expect(arcadeMerklePathOverride({}, ARC, tracker)).toBeUndefined()
    expect(arcadeMerklePathOverride({ rules: 'default' }, ARC, tracker)).toBeUndefined()
    expect(typeof arcadeMerklePathOverride({ rules: 'regtest' }, ARC, tracker)?.merklePath).toBe('function')
  })
})
