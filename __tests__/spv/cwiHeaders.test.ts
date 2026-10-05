/**
 * The page-facing header calls (`window.CWI.getHeaderForHeight` / `getHeight`) end in
 * Services.getHeaderForHeight / getHeight, which read `options.chaintracks`. In spv
 * mode that is the strict tracker, so a page gets the wallet's VERIFIED header, or an
 * error, and never the remote's word.
 */
import { createServices } from '@bsv/expo-wallet-toolbox/core/services/walletServiceConfig'
import { configureToolbox } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { OfflineFirstChaintracks } from '@bsv/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks'
import { concat, mineChain } from './helpers'

const RATE = { timestamp: new Date(), base: 'USD', rate: 50 } as never

async function setup(strict: boolean) {
  configureToolbox({
    backupUrl: null,
    services: { teratest: { arcUrl: 'http://192.168.1.20:8080', chaintracksUrl: 'http://192.168.1.20:8083/chaintracks/v1' } }
  })
  const chain = mineChain(8, { tag: 'cwi' })
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 0, hash: chain[0].hash })
  await store.append(concat(chain.slice(1)), 1)
  // A remote that lies about everything.
  const liar = {
    findHeaderForHeight: async (h: number) => ({
      version: 1, previousHash: '00'.repeat(32), merkleRoot: 'ee'.repeat(32), time: 1, bits: 0x207fffff, nonce: 0, height: h, hash: 'ff'.repeat(32)
    }),
    currentHeight: async () => 9_999_999,
    getChain: async () => 'ttn'
  }
  const offline = new OfflineFirstChaintracks(liar as never, async () => true, 'ttn', { strict })
  offline.setStore(store)
  const { services } = createServices('teratest', 'tok', RATE, undefined, undefined, offline)
  return { services, store, chain }
}

describe('page-facing header calls', () => {
  afterEach(() => configureToolbox({ backupUrl: null }))

  it('spv: getHeaderForHeight returns the verified header, not the remote one', async () => {
    const { services, chain } = await setup(true)
    const bytes = await services.getHeaderForHeight(5)
    expect(Uint8Array.from(bytes)).toEqual(chain[5].bytes)
  })

  it('spv: a height the verified chain lacks is an error', async () => {
    const { services } = await setup(true)
    await expect(services.getHeaderForHeight(500)).rejects.toThrow()
  })

  it('spv: getHeight is the verified tip, not the remote claim', async () => {
    const { services, store } = await setup(true)
    expect(await services.getHeight()).toBe(store.tipHeight)
  })

  it('control: without strict mode the remote still answers (public behaviour is unchanged)', async () => {
    const { services } = await setup(false)
    expect(await services.getHeight()).toBe(9_999_999)
  })
})
