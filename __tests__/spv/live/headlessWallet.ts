/**
 * A real wallet, headless: the toolbox's own Wallet, StorageExpoSQLite on an
 * in-memory SQLite database (node:sqlite behind the expo-sqlite shim), services
 * built the way WalletContext builds them for spv mode, and the strict header
 * chain. No device, no UI, no real data directory: everything is in memory and
 * disappears with the test process.
 *
 * Tests using this must mock expo-sqlite and diskSpace (see wallet.live.test.ts)
 * and run in the live environment (real Node fetch).
 */
import { KeyDeriver, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { Monitor, StorageProvider, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { generateMnemonicWallet } from '@bsv/expo-wallet-toolbox/core/mnemonicWallet'
import { StorageExpoSQLite } from '@bsv/expo-wallet-toolbox/core/storage/StorageExpoSQLite'
import { HeaderStore } from '@bsv/expo-wallet-toolbox/core/headers/headerStore'
import { memoryHeaderFs } from '@bsv/expo-wallet-toolbox/core/headers/fs'
import { OfflineFirstChaintracks } from '@bsv/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks'
import { syncHeaders } from '@bsv/expo-wallet-toolbox/core/headers/syncHeaders'
import { createServices } from '@bsv/expo-wallet-toolbox/core/services/walletServiceConfig'
import { createArcadeBroadcastService } from '@bsv/expo-wallet-toolbox/core/services/arcadeBroadcastProvider'
import { applySpvServices } from '@bsv/expo-wallet-toolbox/core/spv/applySpvServices'
import { arcadeMerklePathOverride } from '@bsv/expo-wallet-toolbox/core/spv/arcadeMerklePath'
import { resolveHeaderSetup } from '@bsv/expo-wallet-toolbox/core/spv/headerSetup'
import { makeRemoteChaintracks } from '@bsv/expo-wallet-toolbox/core/spv/remoteChaintracks'
import { assertSpvEndpoints } from '@bsv/expo-wallet-toolbox/core/spv/spvMode'
import { configureToolbox, getSpvOptions } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { ARCADE, CHAINTRACKS, nodeFetch, REGTEST_GENESIS } from './stack'

const RATE = { timestamp: new Date(), base: 'USD', rate: 50 } as never

export interface HeadlessWallet {
  wallet: Wallet
  storage: StorageExpoSQLite
  store: HeaderStore
  offline: OfflineFirstChaintracks
  services: any
  identityKey: string
  keyDeriver: KeyDeriver
  manager: WalletStorageManager
  /** Run the monitor's proof task once (the same task the app runs), returning its log. */
  checkForProofs(): Promise<string>
  /** Pull headers from Arcade's chaintracks into the wallet's verified chain. */
  syncHeaders(): Promise<Awaited<ReturnType<typeof syncHeaders>>>
  /** Rows of a table, for asserting what the wallet actually stored. */
  rows(sql: string, params?: unknown[]): Promise<any[]>
}

export async function makeHeadlessWallet(): Promise<HeadlessWallet> {
  // Real network for the code under test. The spv guard installed by configureToolbox
  // wraps whatever fetch is global at that moment, so set it first.
  globalThis.fetch = nodeFetch
  configureToolbox({
    backupUrl: null,
    chainMode: 'spv',
    services: { teratest: { arcUrl: ARCADE, chaintracksUrl: CHAINTRACKS } },
    spv: { rules: 'regtest', anchor: { height: 0, hash: REGTEST_GENESIS } }
  })
  assertSpvEndpoints('teratest', { arcUrl: ARCADE, chaintracksUrl: CHAINTRACKS })

  const w = generateMnemonicWallet()
  const identityKey = w.identityKey
  const keyDeriver = new KeyDeriver(new PrivateKey(w.primaryKey))

  const setup = resolveHeaderSetup('ttn', getSpvOptions())!
  const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', setup.anchor, setup.rules)
  const remote = makeRemoteChaintracks('ttn', CHAINTRACKS, getSpvOptions())
  const offline = new OfflineFirstChaintracks(remote, async () => true, 'ttn', { strict: true })
  offline.setStore(store)

  const token = 'live-test-callback-token'
  const { services, serviceOptions } = createServices('teratest', token, RATE, ARCADE, undefined, offline)
  // As WalletContext does for broadcast, then narrow to Arcade for spv.
  services.postBeefServices.remove('ArcadeBeef')
  services.postBeefServices.add(createArcadeBroadcastService(serviceOptions.arcUrl!, token))
  applySpvServices(services, {
    ...arcadeMerklePathOverride(getSpvOptions(), serviceOptions.arcUrl!, offline as never),
    headers: offline
  })

  const storage = new StorageExpoSQLite({
    ...StorageProvider.createStorageBaseOptions('ttn'),
    feeModel: { model: 'sat/kb', value: 100 },
    identityKey,
    databaseName: `live-${Date.now()}`
  } as never)
  storage.setServices(services)
  await storage.migrate('bsv-live', identityKey)

  const manager = new WalletStorageManager(identityKey)
  await manager.addWalletStorageProvider(storage as never)
  const signer = new WalletSigner('ttn', keyDeriver, manager)
  const wallet = new Wallet(signer, services)

  return {
    wallet,
    storage,
    store,
    offline,
    services,
    identityKey,
    keyDeriver,
    manager,
    checkForProofs: async () => {
      const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions('ttn', manager, services, offline as never, 'default'))
      const task = monitor._tasks.find((t: any) => t.name === 'CheckForProofs') as any
      // As WalletContext does: the task needs a current height, taken from the verified chain here.
      monitor.lastNewHeader = { height: store.tipHeight } as never
      task.checkNow = true
      return String(await task.runTask())
    },
    syncHeaders: () => syncHeaders({ store, client: remote as never }),
    rows: async (sql, params = []) => (storage as any).db.getAllAsync(sql, params)
  }
}

/** A BRC-29 payment output for the wallet, as a sender would build it. */
export function paymentFor(identityKey: string) {
  const sender = PrivateKey.fromRandom()
  const rnd = () => Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
  const derivationPrefix = rnd()
  const derivationSuffix = rnd()
  const childPub = PublicKey.fromString(identityKey).deriveChild(sender, `2-3241645161d8-${derivationPrefix} ${derivationSuffix}`)
  return {
    pubKeyHash: childPub.toHash() as number[],
    remittance: {
      senderIdentityKey: sender.toPublicKey().toString(),
      derivationPrefix,
      derivationSuffix
    }
  }
}
