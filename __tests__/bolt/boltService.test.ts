/**
 * window.BOLT, end to end without a device: the page script the app injects, the app-side service
 * (utils/bolt/boltService.ts) and the bundled handler (vendor/bolt), on this app's own @bsv/sdk.
 *
 * Each "app" here is a wallet (the SDK's ProtoWallet for keys), a SQLite token database (node:sqlite
 * behind the same sync calls expo-sqlite has) and a prompt that records what it was asked. The
 * network is a fake Arcade behind `fetch`: it knows which transactions it has seen and refuses one
 * whose inputs it has not.
 */
import { LockingScript, MerklePath, PrivateKey, ProtoWallet, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { ADMIN_ORIGINATOR } from '@/context/config'
import { buildBoltService, serveBolt, type BoltDeps, type SqlDatabase } from '@/utils/bolt/boltService'
import { buildWalletDocumentStartScript } from '@/utils/webview/documentStartScript'
import { buildWalletResponseScript } from '@/utils/webview/walletResponseScript'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite')

const ARCADE = 'http://arcade.test'

function fakeNetwork() {
  const seen = new Map<string, Transaction>()
  const headers = new Map<number, string>()
  const posted: string[] = []
  let height = 100
  /** A mined transaction paying `scriptHex`: a one-transaction block whose merkle root is its txid. */
  const mine = (scriptHex: string, satoshis: number) => {
    const tx = new Transaction(1, [], [{ satoshis, lockingScript: LockingScript.fromHex(scriptHex) }], ++height)
    const txid = tx.id('hex')
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]])
    const header = new Array(80).fill(0)
    header.splice(36, 32, ...Utils.toArray(txid, 'hex').reverse())
    headers.set(height, Utils.toHex(header))
    seen.set(txid, tx)
    return tx
  }
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    if (!url.startsWith(ARCADE + '/tx')) throw new Error(`unexpected request to ${url}`)
    if (init?.method === 'POST') {
      const hex = String(init.body)
      let tx: Transaction
      try {
        tx = Transaction.fromHexEF(hex)
      } catch {
        tx = Transaction.fromHex(hex)
      }
      const txid = tx.id('hex')
      posted.push(txid)
      if (tx.inputs.every(i => seen.has(i.sourceTXID as string))) seen.set(txid, tx)
      return reply(202, { txid })
    }
    const txid = url.slice((ARCADE + '/tx/').length)
    if (seen.has(txid)) return reply(200, { txid, txStatus: 'SEEN_ON_NETWORK' })
    return posted.includes(txid) ? reply(200, { txid, txStatus: 'REJECTED' }) : reply(404, {})
  }) as unknown as typeof fetch
  return { seen, headers, posted, mine, fetch: fetchImpl }
}

function memoryDatabase(): SqlDatabase {
  const d = new DatabaseSync(':memory:')
  return {
    execSync: sql => d.exec(sql),
    runSync: (sql, params) => d.prepare(sql).run(...params),
    getFirstSync: (sql, params) => d.prepare(sql).get(...params),
    getAllSync: (sql, params) => d.prepare(sql).all(...params)
  }
}

/** One device: a wallet, its token database, and its user. */
function device(net: ReturnType<typeof fakeNetwork>, { answer = true } = {}) {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const originators: unknown[] = []
  const used: string[] = []
  const as = (name: string, originator: unknown) => {
    used.push(name)
    originators.push(originator)
  }
  const newWallet = () =>
    ({
      getPublicKey: (args: any, originator: unknown) => (as('getPublicKey', originator), proto.getPublicKey(args)),
      createSignature: (args: any, originator: unknown) => (as('createSignature', originator), proto.createSignature(args)),
      getHeaderForHeight: async ({ height }: { height: number }, originator: unknown) => (
        as('getHeaderForHeight', originator), { header: net.headers.get(height) }
      ),
      createAction: async ({ outputs }: any, originator: unknown) => {
        as('createAction', originator)
        const tx = net.mine(outputs[0].lockingScript, outputs[0].satoshis)
        return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
      }
    }) as unknown as WalletInterface
  const db = memoryDatabase()
  const prompts: { origin: string; method: string; summary: string }[] = []
  const deps: BoltDeps = {
    openDatabase: () => db,
    approve: async ask => (prompts.push(ask), answer),
    fetch: net.fetch
  }
  return { wallet: newWallet(), newWallet, deps, prompts, originators, used }
}

/**
 * A page in this app's WebView: the real document-start script, and the app's side of the bridge
 * as app/index.tsx does it (serve with the origin the app resolved, inject the reply script).
 */
function page(dev: ReturnType<typeof device>, origin: string, wallet = dev.wallet) {
  const listeners = new Set<(event: { data: string; source: null }) => void>()
  const win: Record<string, any> = {
    location: { origin: `https://${origin}` },
    frames: [],
    addEventListener: (type: string, l: any) => type === 'message' && listeners.add(l),
    removeEventListener: (type: string, l: any) => type === 'message' && listeners.delete(l),
    dispatchEvent: (event: { data: string }) => {
      for (const l of [...listeners]) l({ data: event.data, source: null })
      return true
    }
  }
  win.top = win
  win.window = win
  win.ReactNativeWebView = {
    postMessage: (text: string) => {
      const msg = JSON.parse(text)
      if (msg.type !== 'BOLT') return
      void serveBolt(wallet, 'main', origin, msg, dev.deps).then(reply => {
        const MessageEvent = function (this: any, _type: string, init: { data: string }) {
          this.data = init.data
        }
        Function('window', 'MessageEvent', buildWalletResponseScript(reply, `https://${origin}`))(win, MessageEvent)
      })
    }
  }
  Function('window', 'crypto', buildWalletDocumentStartScript(''))(win, globalThis.crypto)
  return win
}

beforeEach(() => configureToolbox({ backupUrl: null, services: { main: { arcUrl: ARCADE + '/' } } }))
afterEach(() => resetToolboxConfig())

describe('window.BOLT in the app', () => {
  it('is installed by the document-start script, beside window.CWI', () => {
    const win = page(device(fakeNetwork()), 'shop.example')
    expect(typeof win.CWI?.getPublicKey).toBe('function')
    expect(Object.keys(win.BOLT).sort()).toEqual(['getKey', 'list', 'melt', 'mint', 'pay', 'present', 'receive', 'transfer', 'verify'])
    expect(Object.isFrozen(win.BOLT)).toBe(true)
  })

  it('mints and presents: the app prompts in BOLT terms, calls the wallet as itself, and broadcasts', async () => {
    const net = fakeNetwork()
    const issuer = device(net)
    const bolt = page(issuer, 'issuer.example').BOLT

    const key = await bolt.getKey()
    expect(issuer.prompts).toHaveLength(0) // reading the key does not ask

    const minted = await bolt.mint({ type: 'AuthBOLT' })
    expect(minted.id).toMatch(/^[0-9a-f]{64}\.0$/)
    expect(issuer.prompts).toEqual([
      { origin: 'issuer.example', method: 'mint', summary: 'mint a new AuthBOLT token with this wallet as its issuer' }
    ])
    expect(net.posted).toHaveLength(1) // the mint went to Arcade
    expect(net.seen.has(minted.id.split('.')[0])).toBe(true)

    const { package: pkg } = await bolt.present(minted.id, { data: 'c0ffee' })
    expect(issuer.prompts[1].summary).toMatch(/^show token [0-9a-f]{8} to this site with the data c0ffee$/)

    const site = device(net)
    const shown = await page(site, 'site.example').BOLT.verify(pkg, { issuer: key.publicKey })
    expect(shown).toMatchObject({ ok: true, kind: 'presentation', type: 'AuthBOLT', data: 'c0ffee', issuer: key.publicKey })

    // every wallet call was the app's own (no page origin reaches the wallet, so it never prompts)
    expect(new Set(issuer.originators)).toEqual(new Set([ADMIN_ORIGINATOR]))
    expect(new Set(issuer.used)).toEqual(new Set(['getPublicKey', 'createSignature', 'createAction']))
  })

  it('pays part of a fungible token to another device, which receives it', async () => {
    const net = fakeNetwork()
    const issuer = device(net)
    const issuerBolt = page(issuer, 'issuer.example').BOLT
    const issuerKey = (await issuerBolt.getKey()).publicKey
    const user = device(net)
    const userBolt = page(user, 'wallet.example').BOLT

    await issuerBolt.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
    expect(issuer.prompts[0].summary).toBe('mint a new SimpleMultiBOLT token of 1000 with this wallet as its issuer')

    const { package: pkg } = await issuerBolt.pay(issuerKey, '300', (await userBolt.getKey()).publicKey)
    const got = await userBolt.receive(pkg, { issuer: issuerKey })
    expect(got).toMatchObject({ ok: true, kind: 'split', type: 'SimpleMultiBOLT' })
    expect(user.prompts.map(p => p.method)).toEqual(['receive'])

    expect((await userBolt.list()).map((r: any) => r.amount)).toEqual(['300'])
    expect((await issuerBolt.list()).map((r: any) => r.amount)).toEqual(['700'])
  })

  it('keeps tokens in the database: the app restarted still holds and can present them', async () => {
    const net = fakeNetwork()
    const dev = device(net)
    const minted = await page(dev, 'issuer.example').BOLT.mint({ type: 'AuthBOLT' })

    // a new wallet object and a new service, the same key and database: what a restart is
    const again = page(dev, 'issuer.example', dev.newWallet()).BOLT
    const held = await again.list()
    expect(held.map((r: any) => r.id)).toEqual([minted.id])
    const { package: pkg } = await again.present(minted.id, { data: 'aa' })
    expect(pkg).toHaveLength(2)
  })

  it('does nothing when the user declines', async () => {
    const net = fakeNetwork()
    const dev = device(net, { answer: false })
    await expect(page(dev, 'shop.example').BOLT.mint({ type: 'AuthBOLT' })).rejects.toThrow('BOLT: the user declined')
    expect(net.posted).toHaveLength(0)
    expect(dev.used).not.toContain('createAction')
    expect(dev.used).not.toContain('createSignature')
  })

  it('answers with an error, not a hang, when no Arcade URL is configured', async () => {
    configureToolbox({ backupUrl: null, services: { main: {} } })
    const dev = device(fakeNetwork())
    await expect(buildBoltService(dev.wallet, 'main', dev.deps)).rejects.toThrow(/no Arcade URL/)
    await expect(page(dev, 'shop.example').BOLT.getKey()).rejects.toThrow(/BOLT: no Arcade URL/)
  })
})
