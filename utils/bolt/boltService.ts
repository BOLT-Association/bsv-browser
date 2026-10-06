/**
 * window.BOLT: the BOLT token interface for pages, beside window.CWI.
 *
 * The page gets only a thin provider (`webViewProviderScript`, installed with the document-start
 * script). Everything else is here, in the app: the handler (b017, bundled in vendor/bolt), the
 * keys (the wallet, called as the app itself), the tokens (a SQLite file per wallet key) and the
 * prompt, which says what is being asked ("transfer token … to …") and names the origin the app
 * determined for the frame.
 *
 * The wallet is called with the admin originator, so its own permission prompts do not appear for
 * these calls: consent for a BOLT operation is the prompt below, once, in BOLT's terms.
 */
import * as SQLite from 'expo-sqlite'
import type { WalletInterface } from '@bsv/sdk'
import { ADMIN_ORIGINATOR } from '@/context/config'
import { getServiceConfig } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { showAlert } from '@bsv/expo-wallet-toolbox/ui/components/ui/AlertCard'
import { BOLT_MESSAGE, BOLT_PROTOCOL, boltReply, hostService, sqlStore } from '@/vendor/bolt/bolt'

export { BOLT_MESSAGE }

type Chain = 'main' | 'test' | 'teratest'
type Response = { result?: unknown; error?: string }
type Serve = (origin: string, request: { method?: unknown; args?: unknown }) => Promise<Response>
type Ask = { origin: string; method: string; summary: string }

/** The four wallet methods the handler uses, called as the app itself (never prompted). */
type AdminWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature' | 'getHeaderForHeight' | 'createAction'>

export interface BoltDeps {
  /** Open the token database (expo-sqlite's sync API). Replaced in tests. */
  openDatabase: (name: string) => SqlDatabase
  /** Ask the user. Replaced in tests. */
  approve: (ask: Ask) => Promise<boolean>
  /** The network. Replaced in tests. */
  fetch?: typeof fetch
}

export interface SqlDatabase {
  execSync: (sql: string) => void
  runSync: (sql: string, params: unknown[]) => unknown
  getFirstSync: (sql: string, params: unknown[]) => unknown
  getAllSync: (sql: string, params: unknown[]) => unknown[]
}

const askUser = async ({ origin, summary }: Ask): Promise<boolean> =>
  (await showAlert({
    title: `${origin} asks to`,
    message: summary,
    buttons: [
      { text: 'Decline', key: 'no', style: 'cancel' },
      { text: 'Approve', key: 'yes' }
    ]
  })) === 'yes'

const defaults: BoltDeps = {
  openDatabase: name => SQLite.openDatabaseSync(name) as unknown as SqlDatabase,
  approve: askUser
}

/** SQLite binds null, not undefined. */
const bind = (params: unknown[] = []) => params.map(p => (p === undefined ? null : p))

export async function buildBoltService(wallet: WalletInterface, chain: Chain, deps: BoltDeps = defaults): Promise<Serve> {
  const admin: AdminWallet = {
    getPublicKey: args => wallet.getPublicKey(args, ADMIN_ORIGINATOR),
    createSignature: args => wallet.createSignature(args, ADMIN_ORIGINATOR),
    getHeaderForHeight: args => wallet.getHeaderForHeight(args, ADMIN_ORIGINATOR),
    createAction: args => wallet.createAction(args, ADMIN_ORIGINATOR)
  }
  const { arcUrl, arcApiKey } = getServiceConfig(chain)
  if (!arcUrl) throw new Error('no Arcade URL is configured for this network')

  // Tokens are kept per wallet key and network: another wallet on this device has its own file.
  const { publicKey } = await admin.getPublicKey({ protocolID: BOLT_PROTOCOL, keyID: '1', counterparty: 'self' })
  const db = deps.openDatabase(`bolt-tokens-${chain}-${publicKey.slice(2, 18)}.db`)
  const store = sqlStore({
    exec: (sql: string) => db.execSync(sql),
    run: (sql: string, params?: unknown[]) => db.runSync(sql, bind(params)),
    get: (sql: string, params?: unknown[]) => db.getFirstSync(sql, bind(params)) ?? undefined,
    all: (sql: string, params?: unknown[]) => db.getAllSync(sql, bind(params))
  })

  const net = deps.fetch ?? fetch
  const withKey: typeof fetch = arcApiKey
    ? (url, init = {}) => net(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${arcApiKey}` } })
    : net
  return hostService({ wallet: admin, arcadeUrl: arcUrl.replace(/\/+$/, ''), fetch: withKey, store, approve: deps.approve })
}

// One service per wallet object and network, built on first use.
const services = new WeakMap<object, Map<Chain, Promise<Serve>>>()

function serviceFor(wallet: WalletInterface, chain: Chain, deps: BoltDeps): Promise<Serve> {
  let perChain = services.get(wallet)
  if (!perChain) services.set(wallet, (perChain = new Map()))
  let service = perChain.get(chain)
  if (!service) {
    service = buildBoltService(wallet, chain, deps)
    perChain.set(chain, service)
    service.catch(() => perChain!.delete(chain)) // a failed build is retried on the next request
  }
  return service
}

/**
 * Answer one message from a page's window.BOLT. `origin` is the originator the app resolved for the
 * frame; nothing the page says about itself is used. Never throws: the reply carries the error.
 */
export async function serveBolt(
  wallet: WalletInterface,
  chain: Chain,
  origin: string,
  msg: { id: string; method?: unknown; args?: unknown },
  deps: BoltDeps = defaults
): Promise<object> {
  try {
    const serve = await serviceFor(wallet, chain, deps)
    return boltReply(msg.id, await serve(origin, { method: msg.method, args: msg.args }))
  } catch (e) {
    return boltReply(msg.id, { error: `BOLT: ${(e as Error)?.message ?? String(e)}` })
  }
}
