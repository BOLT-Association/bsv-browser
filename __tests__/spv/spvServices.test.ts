import { applySpvServices } from '@bsv/expo-wallet-toolbox/core/spv/applySpvServices'
import { createServices } from '@bsv/expo-wallet-toolbox/core/services/walletServiceConfig'
import { configureToolbox } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'

const RATE = { timestamp: new Date(), base: 'USD', rate: 50 } as never
const TXID = 'ab'.repeat(32)

function build() {
  configureToolbox({
    backupUrl: null,
    services: {
      test: {
        arcUrl: 'http://192.168.1.20:8080',
        chaintracksUrl: 'http://192.168.1.20:8083/chaintracks/v1',
        whatsOnChainApiKey: 'k'
      }
    }
  })
  const { services } = createServices('test', 'tok', RATE)
  return services as any
}
const names = (c: any): string[] => c.services.map((s: { name: string }) => s.name)

describe('applySpvServices', () => {
  afterEach(() => configureToolbox({ backupUrl: null }))

  it('control: the default services reach public indexers', () => {
    const s = build()
    expect(names(s.getRawTxServices).length).toBeGreaterThan(0)
    expect(names(s.getRawTxServices).some((n: string) => /whatsonchain|bitails/i.test(n))).toBe(true)
    expect(names(s.getMerklePathServices).some((n: string) => n !== 'Arcade')).toBe(true)
  })

  it('leaves only Arcade for proofs, status and broadcast', () => {
    const s = build()
    applySpvServices(s)
    expect(names(s.getMerklePathServices)).toEqual(['Arcade'])
    expect(names(s.getStatusForTxidsServices)).toEqual(['Arcade'])
    expect(names(s.postBeefServices).every((n: string) => /^Arcade/.test(n))).toBe(true)
    expect(names(s.postBeefServices).length).toBeGreaterThan(0)
  })

  it('replaces raw-tx, utxo and address-history lookups with explicit errors, never empty answers', async () => {
    const s = build()
    applySpvServices(s)
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('must not be called')
    }) as never)
    try {
      const raw = await s.getRawTx(TXID)
      expect(raw.rawTx).toBeUndefined()
      expect(raw.error).toBeDefined()

      const utxo = await s.getUtxoStatus('00'.repeat(32), undefined, `${TXID}.0`)
      expect(utxo.status).toBe('error')
      expect(utxo.error).toBeDefined()

      const hist = await s.getScriptHashHistory('00'.repeat(32))
      expect(hist.status).toBe('error')
      expect(hist.error).toBeDefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('fails if Arcade is not configured (nothing to keep)', () => {
    configureToolbox({ backupUrl: null })
    const s = build()
    s.getMerklePathServices.services = s.getMerklePathServices.services.filter((x: { name: string }) => x.name !== 'Arcade')
    expect(() => applySpvServices(s)).toThrow(/Arcade/)
  })

  it('can replace the Arcade proof provider, keeping its name', async () => {
    const s = build()
    const override = jest.fn(async (txid: string) => ({ name: 'Arcade', txid }))
    applySpvServices(s, { merklePath: override })
    expect(names(s.getMerklePathServices)).toEqual(['Arcade'])
    await s.getMerklePathServices.services[0].service(TXID)
    expect(override).toHaveBeenCalledWith(TXID)
  })

  it('answers header-by-hash from the verified chain only, never from the remote', async () => {
    const s = build()
    const header = { height: 5, hash: 'ab'.repeat(32), merkleRoot: 'cd'.repeat(32) }
    const headers = { findHeaderForBlockHash: jest.fn(async (h: string) => (h === header.hash ? header : undefined)) }
    applySpvServices(s, { headers: headers as never })
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('must not be called')
    }) as never)
    try {
      await expect(s.hashToHeader(header.hash)).resolves.toEqual(header)
      await expect(s.hashToHeader('ee'.repeat(32))).rejects.toThrow(/verified/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('an empty Arcade API key becomes absent, because the toolbox SSE client rejects an empty one', () => {
    const s = build()
    expect(s.options.arcadeConfig.apiKey).toBe('') // control: what createServiceOptions produces with no key
    applySpvServices(s)
    expect(s.options.arcadeConfig.apiKey).toBeUndefined()
  })

  it('keeps a real Arcade API key', () => {
    configureToolbox({
      backupUrl: null,
      services: { test: { arcUrl: 'http://192.168.1.20:8080', chaintracksUrl: 'http://192.168.1.20:8083/chaintracks/v1', arcApiKey: 'real-key' } }
    })
    const { services } = createServices('test', 'tok', RATE)
    applySpvServices(services as never)
    expect((services as any).options.arcadeConfig.apiKey).toBe('real-key')
  })

  it('leaves hashToHeader alone when no verified source is given (control)', async () => {
    const s = build()
    const original = s.hashToHeader
    applySpvServices(s)
    expect(s.hashToHeader).toBe(original)
  })
})
