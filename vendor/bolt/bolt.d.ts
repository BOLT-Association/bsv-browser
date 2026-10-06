// Types for vendor/bolt/bolt.js (generated from ChainBrowsers packages/bolt; see vendor/bolt/README.md).
export const BOLT_MESSAGE: 'BOLT'
export const BOLT_PROTOCOL: [1, string]
export const PAGE_METHODS: Record<string, { asks: boolean }>
export const TOKENS_SCHEMA: string

export type BoltResponse = { result?: unknown; error?: string }
export function boltReply(id: string, response: BoltResponse): { type: 'BOLT'; id: string; isReply: true } & BoltResponse

/** The script that defines window.BOLT in a page (main frame only). */
export function webViewProviderScript(options?: { timeoutMs?: number }): string

export interface SqlAdapter {
  exec: (sql: string) => void
  run: (sql: string, params?: unknown[]) => unknown
  get: (sql: string, params?: unknown[]) => unknown
  all: (sql: string, params?: unknown[]) => unknown[]
  close?: () => void
}
export interface TokenStore {
  put: (record: unknown) => Promise<void>
  get: (id: string) => Promise<unknown>
  list: (filter?: { status?: string; issuer?: string; type?: string }) => Promise<unknown[]>
  delete: (id: string) => Promise<void>
}
export function sqlStore(db: SqlAdapter, options?: { now?: () => number }): TokenStore
export function memoryStore(): TokenStore

export type Broadcaster = (tx: unknown) => Promise<{ status: 'accepted' | 'already-seen' | 'rejected'; detail?: string }>
export function arcadeBroadcaster(options: { arcadeUrl: string; fetch?: typeof fetch; timeoutMs?: number; everyMs?: number }): Broadcaster

export function hostService(options: {
  wallet: {
    getPublicKey: (args: any) => Promise<{ publicKey: string }>
    createSignature: (args: any) => Promise<{ signature: number[] }>
    getHeaderForHeight: (args: any) => Promise<{ header: string }>
    createAction: (args: any) => Promise<any>
  }
  arcadeUrl?: string
  broadcast?: Broadcaster
  fetch?: typeof fetch
  store?: TokenStore
  approve: (ask: { origin: string; method: string; summary: string }) => Promise<boolean>
  trustedIssuers?: string[]
}): (origin: string, request: { method?: unknown; args?: unknown }) => Promise<BoltResponse>
