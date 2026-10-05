import {
  assertSpvEndpoints,
  installIndexerGuard,
  isBlockedIndexerUrl,
  parseChainMode
} from '@bsv/expo-wallet-toolbox/core/spv/spvMode'
import { configureToolbox, getChainMode, getSpvOptions } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'

describe('parseChainMode: fails closed', () => {
  it.each([undefined, null, '', 'public', 'PUBLIC', ' public '])('%p is public', raw => {
    expect(parseChainMode(raw as string | undefined)).toBe('public')
  })
  it.each(['spv', 'SPV', ' spv '])('%p is spv', raw => {
    expect(parseChainMode(raw)).toBe('spv')
  })
  it.each(['spv-header-chain', 'local', 'off', '0', 'publik'])('an unrecognised value (%p) means spv, never public', raw => {
    expect(parseChainMode(raw)).toBe('spv')
  })
})

describe('isBlockedIndexerUrl', () => {
  it.each([
    'https://api.whatsonchain.com/v1/bsv/main/tx/abc/hex',
    'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test/tx/abc',
    'https://arc.taal.com/v1/tx',
    'https://arc-test.taal.com/v1/tx',
    'https://arc-teratest.taal.com/v1/tx',
    'https://arc.gorillapool.io/v1/tx',
    'https://junglebus.gorillapool.io/v1/address/get/x',
    'https://ordinals.gorillapool.io/api/x',
    'https://api.bitails.io/tx/abc',
    'https://API.WhatsOnChain.com/x'
  ])('blocks %s', url => {
    expect(isBlockedIndexerUrl(url)).toBe(true)
  })
  it.each([
    'https://arcade-v2-us-1.bsvblockchain.tech/tx',
    'https://arcade-us-1.bsvb.tech/chaintracks/v1/getHeaders',
    'http://192.168.1.20:8080/tx',
    'http://10.0.2.2:8083/chaintracks/v1/headers',
    'http://localhost:8082/events',
    'https://gmb.bsvblockchain.tech/'
  ])('allows %s', url => {
    expect(isBlockedIndexerUrl(url)).toBe(false)
  })
  it('does not treat a lookalike host as an indexer or an indexer name in the path as a host', () => {
    expect(isBlockedIndexerUrl('https://notwhatsonchain.com/x')).toBe(false)
    expect(isBlockedIndexerUrl('https://example.com/api.whatsonchain.com')).toBe(false)
  })
  it('treats an unparseable URL as blocked (an error, never a pass)', () => {
    expect(isBlockedIndexerUrl('not a url')).toBe(true)
  })
})

describe('installIndexerGuard', () => {
  const makeGlobal = () => {
    const calls: string[] = []
    const g = {
      fetch: (async (input: unknown) => {
        calls.push(typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input))
        return { ok: true } as Response
      }) as typeof fetch
    }
    return { g, calls }
  }

  it('rejects a call to a public indexer without making it', async () => {
    const { g, calls } = makeGlobal()
    installIndexerGuard(g)
    await expect(g.fetch('https://api.whatsonchain.com/v1/bsv/main/tx/abc/hex')).rejects.toThrow(/spv/i)
    expect(calls).toEqual([])
  })

  it('catches URL objects and Request-like objects too', async () => {
    const { g, calls } = makeGlobal()
    installIndexerGuard(g)
    await expect(g.fetch(new URL('https://arc.taal.com/v1/tx'))).rejects.toThrow(/spv/i)
    await expect(g.fetch({ url: 'https://arc.gorillapool.io/v1/tx' } as never)).rejects.toThrow(/spv/i)
    expect(calls).toEqual([])
  })

  it('passes everything else through to the original fetch', async () => {
    const { g, calls } = makeGlobal()
    installIndexerGuard(g)
    await g.fetch('http://192.168.1.20:8080/tx')
    expect(calls).toEqual(['http://192.168.1.20:8080/tx'])
  })

  it('restores the original fetch', async () => {
    const { g, calls } = makeGlobal()
    const original = g.fetch
    const restore = installIndexerGuard(g)
    restore()
    expect(g.fetch).toBe(original)
    await g.fetch('https://api.whatsonchain.com/x')
    expect(calls.length).toBe(1)
  })

  it('is idempotent: installing twice does not stack wrappers', async () => {
    const { g } = makeGlobal()
    const r1 = installIndexerGuard(g)
    const wrapped = g.fetch
    installIndexerGuard(g)
    expect(g.fetch).toBe(wrapped)
    r1()
  })
})

describe('assertSpvEndpoints', () => {
  const ok = { arcUrl: 'http://192.168.1.20:8080', chaintracksUrl: 'http://192.168.1.20:8083/chaintracks/v1' }
  it('accepts an Arcade and chaintracks URL', () => {
    expect(() => assertSpvEndpoints('teratest', ok)).not.toThrow()
  })
  it('refuses spv with no Arcade URL', () => {
    expect(() => assertSpvEndpoints('teratest', { chaintracksUrl: ok.chaintracksUrl })).toThrow(/EXPO_PUBLIC.*ARC_URL/)
  })
  it('refuses spv with no chaintracks URL', () => {
    expect(() => assertSpvEndpoints('teratest', { arcUrl: ok.arcUrl })).toThrow(/CHAINTRACKS_URL/)
  })
  it('refuses an endpoint that is itself a public indexer', () => {
    expect(() => assertSpvEndpoints('main', { ...ok, arcUrl: 'https://arc.taal.com' })).toThrow(/indexer/i)
  })
  it('names the env vars of the chain it was asked about', () => {
    expect(() => assertSpvEndpoints('main', {})).toThrow(/EXPO_PUBLIC_ARC_URL/)
    expect(() => assertSpvEndpoints('test', {})).toThrow(/EXPO_PUBLIC_TEST_ARC_URL/)
    expect(() => assertSpvEndpoints('teratest', {})).toThrow(/EXPO_PUBLIC_TERATEST_ARC_URL/)
  })
})

describe('configureToolbox chain mode', () => {
  afterEach(() => {
    configureToolbox({ backupUrl: null })
  })
  it('defaults to public with no spv options', () => {
    configureToolbox({ backupUrl: null })
    expect(getChainMode()).toBe('public')
    expect(getSpvOptions()).toEqual({})
  })
  it('resolves a raw env value through parseChainMode', () => {
    configureToolbox({ backupUrl: null, chainMode: 'spv' })
    expect(getChainMode()).toBe('spv')
    configureToolbox({ backupUrl: null, chainMode: 'whatever' })
    expect(getChainMode()).toBe('spv')
  })
  it('carries the spv rule set and anchor', () => {
    const anchor = { height: 0, hash: 'ab'.repeat(32) }
    configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { rules: 'regtest', anchor } })
    expect(getSpvOptions()).toEqual({ rules: 'regtest', anchor })
  })
  it('refuses an anchor that is not a height and 64-hex hash', () => {
    expect(() => configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { anchor: { height: -1, hash: 'ab'.repeat(32) } } })).toThrow(/anchor/)
    expect(() => configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { anchor: { height: 0, hash: 'xyz' } } })).toThrow(/anchor/)
  })
})

describe('configureToolbox installs the indexer guard in spv mode only', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    configureToolbox({ backupUrl: null })
    globalThis.fetch = realFetch
  })
  it('blocks public indexers after spv configuration', async () => {
    globalThis.fetch = (async () => ({ ok: true }) as Response) as typeof fetch
    configureToolbox({ backupUrl: null, chainMode: 'spv' })
    await expect(fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info')).rejects.toThrow(/spv/i)
  })
  it('does not block them in public mode (control)', async () => {
    globalThis.fetch = (async () => ({ ok: true }) as Response) as typeof fetch
    configureToolbox({ backupUrl: null, chainMode: 'public' })
    await expect(fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info')).resolves.toBeDefined()
  })
  it('reconfiguring back to public removes the guard', async () => {
    globalThis.fetch = (async () => ({ ok: true }) as Response) as typeof fetch
    configureToolbox({ backupUrl: null, chainMode: 'spv' })
    configureToolbox({ backupUrl: null })
    await expect(fetch('https://api.whatsonchain.com/x')).resolves.toBeDefined()
  })
})
