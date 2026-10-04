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
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
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
import { makeSpvEventSourceClass } from '@bsv/expo-wallet-toolbox/core/spv/spvEventSource'
import { guardZeroConfInternalize } from '@bsv/expo-wallet-toolbox/core/spv/zeroConf'
import { NodeEventSource } from './nodeEventSource'
import { resolveHeaderSetup } from '@bsv/expo-wallet-toolbox/core/spv/headerSetup'
import { makeRemoteChaintracks } from '@bsv/expo-wallet-toolbox/core/spv/remoteChaintracks'
import { assertSpvEndpoints } from '@bsv/expo-wallet-toolbox/core/spv/spvMode'
import { configureToolbox, getSpvOptions } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { ARCADE, CHAINTRACKS, mineUntilMined, nodeFetch, REGTEST_GENESIS, spendCoinbase } from './stack'

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
  /** Run the monitor's SendWaiting task once (broadcasts requests still `unsent`/`sending`), returning its log. */
  sendWaiting(): Promise<string>
  /** The callback token this wallet registers with Arcade at broadcast (SSE events are scoped by it). */
  callbackToken: string
  /** Open the toolbox's ArcadeSSE task (as the app's monitor does). `lastEventId` asks Arcade to replay from there. */
  startSse(lastEventId?: string): Promise<void>
  /** Process every SSE event received so far, as the monitor loop would; returns the task log. */
  drainSse(): Promise<string>
  stopSse(): void
  /** Pull headers from Arcade's chaintracks into the wallet's verified chain. */
  syncHeaders(): Promise<Awaited<ReturnType<typeof syncHeaders>>>
  /** Rows of a table, for asserting what the wallet actually stored. */
  rows(sql: string, params?: unknown[]): Promise<any[]>
}

export interface HeadlessOptions {
  arcUrl?: string
  chaintracksUrl?: string
  /** Arcade API key, as a deployment that needs one would be configured. */
  arcApiKey?: string
  /** Arcade's SSE listener. Without it the wallet has no push (polling only). */
  sseUrl?: string
}

export async function makeHeadlessWallet(opts: HeadlessOptions = {}): Promise<HeadlessWallet> {
  const arcUrl = opts.arcUrl ?? ARCADE
  const chaintracksUrl = opts.chaintracksUrl ?? CHAINTRACKS

  // Real network for the code under test. The spv guard installed by configureToolbox
  // wraps whatever fetch is global at that moment, so set it first.
  globalThis.fetch = nodeFetch
  configureToolbox({
    backupUrl: null,
    chainMode: 'spv',
    services: { teratest: { arcUrl, chaintracksUrl, arcApiKey: opts.arcApiKey } },
    spv: { rules: 'regtest', anchor: { height: 0, hash: REGTEST_GENESIS } }
  })
  assertSpvEndpoints('teratest', { arcUrl, chaintracksUrl })

  const w = generateMnemonicWallet()
  const identityKey = w.identityKey
  const keyDeriver = new KeyDeriver(new PrivateKey(w.primaryKey))

  const setup = resolveHeaderSetup('ttn', getSpvOptions())!
  const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', setup.anchor, setup.rules)
  const remote = makeRemoteChaintracks('ttn', chaintracksUrl, getSpvOptions(), opts.arcApiKey)
  const offline = new OfflineFirstChaintracks(remote, async () => true, 'ttn', { strict: true })
  offline.setStore(store)

  // Unique per wallet: Arcade replays every past event for a token, so a shared token would make each
  // wallet drain the previous runs' events before its own.
  const token = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const { services, serviceOptions } = createServices('teratest', token, RATE, arcUrl, opts.arcApiKey, offline)
  // As WalletContext does for broadcast, then narrow to Arcade for spv.
  services.postBeefServices.remove('ArcadeBeef')
  services.postBeefServices.add(createArcadeBroadcastService(serviceOptions.arcUrl!, token, opts.arcApiKey))
  applySpvServices(services, {
    ...arcadeMerklePathOverride(getSpvOptions(), serviceOptions.arcUrl!, offline as never, opts.arcApiKey),
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
  // As WalletContext does in spv mode: an unmined payment is accepted only once Arcade has seen it.
  ;(wallet as any).internalizeAction = guardZeroConfInternalize(wallet.internalizeAction.bind(wallet) as any, {
    arcUrl: serviceOptions.arcUrl!,
    apiKey: opts.arcApiKey
  })

  // One monitor per wallet, built the way the app builds it, with the spv SSE class. Its tasks are
  // driven by hand from the tests (no timers), so the order of events is the test's.
  let pendingLastEventId: string | undefined
  let monitor: any
  const getMonitor = () => {
    if (!monitor) {
      const options: any = Monitor.createDefaultWalletMonitorOptions('ttn', manager, services, offline as never, 'default')
      options.callbackToken = token
      options.EventSourceClass = makeSpvEventSourceClass(NodeEventSource as never, serviceOptions.arcUrl!, opts.sseUrl)
      options.loadLastSSEEventId = async () => pendingLastEventId
      options.saveLastSSEEventId = async (id: string) => {
        pendingLastEventId = id
      }
      monitor = new Monitor(options)
    }
    return monitor
  }
  const sseTask = () => getMonitor()._tasks.find((t: any) => t.name === 'ArcadeSSE') as any

  return {
    wallet,
    storage,
    store,
    offline,
    services,
    identityKey,
    keyDeriver,
    manager,
    callbackToken: token,
    startSse: async lastEventId => {
      pendingLastEventId = lastEventId
      const t = sseTask()
      await t.asyncSetup()
    },
    drainSse: async () => {
      const t = sseTask()
      let log = ''
      for (let i = 0; i < 20 && t.pendingEvents.length > 0; i++) log += String(await t.runTask())
      return log
    },
    stopSse: () => sseTask().close(),
    sendWaiting: async () => {
      const task = getMonitor()._tasks.find((t: any) => t.name === 'SendWaiting') as any
      return String(await task.runTask())
    },
    checkForProofs: async () => {
      const m = getMonitor()
      const task = m._tasks.find((t: any) => t.name === 'CheckForProofs') as any
      // As WalletContext does: the task needs a current height, taken from the verified chain here.
      m.lastNewHeader = { height: store.tipHeight } as never
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

/** Fund `h` with a mined, Arcade-confirmed coinbase spend, after syncing its chain to that block. */
export async function fundHeadless(h: HeadlessWallet, satoshis: number): Promise<{ txid: string; height: number }> {
  const pay = paymentFor(h.identityKey)
  const tx = await spendCoinbase([{ lockingScript: new P2PKH().lock(pay.pubKeyHash), satoshis }])
  const st = await mineUntilMined(tx.id('hex'))
  tx.merklePath = MerklePath.fromHex(st.merklePath)
  await syncHeadersTo(h, st.blockHeight!)
  const r = await h.wallet.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: pay.remittance }],
    description: 'live funding'
  })
  if (!r.accepted) throw new Error('funding was not accepted')
  return { txid: tx.id('hex'), height: st.blockHeight! }
}

/** Sync the wallet's own header chain until it holds `height` (chaintracks can trail the node by a moment). */
export async function syncHeadersTo(h: HeadlessWallet, height: number): Promise<void> {
  for (let i = 0; i < 40 && h.store.tipHeight < height; i++) {
    await h.syncHeaders()
    if (h.store.tipHeight < height) await new Promise(r => setTimeout(r, 2000))
  }
  if (h.store.tipHeight < height) throw new Error(`wallet header chain never reached ${height}`)
}
