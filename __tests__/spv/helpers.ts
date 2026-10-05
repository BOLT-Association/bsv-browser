import { Utils } from '@bsv/sdk'
import { utils as chaintracksUtils } from '@bsv/wallet-toolbox-mobile'

const { blockHash, serializeBaseBlockHeader } = chaintracksUtils

export const REGTEST_BITS = 0x207fffff

export interface MinedHeader {
  bytes: Uint8Array
  hash: string
  height: number
}

/** Hex string of N random-looking but deterministic 32 bytes, for merkle roots. */
export function rootFor(tag: string): string {
  let h = 0x811c9dc5
  const out: number[] = []
  for (let i = 0; i < 32; i++) {
    for (const c of `${tag}:${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    out.push(h & 0xff)
  }
  return Utils.toHex(out)
}

/** Mine one header whose hash satisfies its own target. Tiny work at regtest bits. */
export function mineHeader(args: {
  previousHash: string
  height: number
  bits?: number
  time?: number
  root?: string
  /** If false, return a header that does NOT meet its target (nonce left at 0 whatever the hash). */
  work?: boolean
}): MinedHeader {
  const bits = args.bits ?? REGTEST_BITS
  const root = args.root ?? rootFor(`h${args.height}`)
  const target = targetOf(bits)
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const bytes = Uint8Array.from(
      serializeBaseBlockHeader({
        version: 1,
        previousHash: args.previousHash,
        merkleRoot: root,
        time: args.time ?? 1_700_000_000 + args.height * 600,
        bits,
        nonce
      } as any)
    )
    const hash = blockHash(bytes)
    if (args.work === false || BigInt('0x' + hash) <= target) return { bytes, hash, height: args.height }
  }
  throw new Error('could not mine test header')
}

export function targetOf(bits: number): bigint {
  const size = bits >>> 24
  const word = BigInt(bits & 0x7fffff)
  return size <= 3 ? word >> BigInt(8 * (3 - size)) : word << BigInt(8 * (size - 3))
}

/** Genesis + n children, all at `bits`. heights 0..n. */
export function mineChain(n: number, opts: { bits?: number; tag?: string; from?: MinedHeader } = {}): MinedHeader[] {
  const out: MinedHeader[] = []
  let prev = opts.from
  let prevHash = prev ? prev.hash : '00'.repeat(32)
  let height = prev ? prev.height + 1 : 0
  for (let i = 0; i < n + (prev ? 0 : 1); i++, height++) {
    const m = mineHeader({
      previousHash: prevHash,
      height,
      bits: opts.bits,
      root: rootFor(`${opts.tag ?? 'main'}:${height}`)
    })
    out.push(m)
    prevHash = m.hash
  }
  return out
}

export const concat = (hs: MinedHeader[]): Uint8Array => {
  const b = new Uint8Array(hs.length * 80)
  hs.forEach((h, i) => b.set(h.bytes, i * 80))
  return b
}

/** A linked header whose hash deterministically does NOT meet its target. */
export function mineInvalid(args: { previousHash: string; height: number; bits?: number }): MinedHeader {
  const bits = args.bits ?? REGTEST_BITS
  const target = targetOf(bits)
  for (let nonce = 0; nonce < 1000; nonce++) {
    const bytes = Uint8Array.from(
      serializeBaseBlockHeader({
        version: 1,
        previousHash: args.previousHash,
        merkleRoot: rootFor(`bad${args.height}`),
        time: 1_700_000_000 + args.height * 600,
        bits,
        nonce
      } as any)
    )
    const hash = blockHash(bytes)
    if (BigInt('0x' + hash) > target) return { bytes, hash, height: args.height }
  }
  throw new Error('could not build an invalid test header')
}
