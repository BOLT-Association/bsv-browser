#!/usr/bin/env node
/**
 * Negative controls for the spv hardening: for each rule, disable it in the
 * installed (patched) toolbox, run the tests that cover it, and require them to
 * FAIL. A test that stays green with its rule removed tests nothing.
 *
 *   node scripts/spv-negative-controls.mjs          # run every control
 *   node scripts/spv-negative-controls.mjs 3 7      # run controls 3 and 7
 *
 * Edits files under node_modules in place and restores each one afterwards (also
 * on Ctrl-C). Run `npx patch-package` afterwards if anything looks off.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const T = 'node_modules/@bsv/expo-wallet-toolbox/core'

const controls = [
  {
    rule: 'regtest: bits must equal the regtest limit',
    file: `${T}/headers/chainRules.ts`,
    from: 'if (h.bits !== REGTEST_POW_LIMIT_BITS) {',
    to: 'if (false) {',
    tests: '__tests__/spv/headerRules'
  },
  {
    rule: 'regtest: hash must meet the declared target',
    file: `${T}/headers/chainRules.ts`,
    from: 'if (!meetsTarget(h.hash, h.bits)) {',
    to: 'if (false) {',
    tests: '__tests__/spv/headerRules'
  },
  {
    rule: 'store reload: re-validate linkage and rules of every stored header',
    file: `${T}/headers/headerStore.ts`,
    from: "if (parsed.previousHash !== prevHash) throw new Error('link')\n        rules.validate({ height: anchor.height + 1 + i, hash, bits: parsed.bits, time: parsed.time }, prev)",
    to: '',
    tests: '__tests__/spv/headerRules'
  },
  {
    rule: 'sync: switch only to a branch with MORE work',
    file: `${T}/headers/syncHeaders.ts`,
    from: "if (theirs <= ours) return { kind: 'less-work' }",
    to: '',
    tests: '__tests__/spv/syncReorg'
  },
  {
    rule: 'sync: refuse a reorg deeper than maxReorgDepth',
    file: `${T}/headers/syncHeaders.ts`,
    from: 'const lowest = Math.max(store.baseHeight, store.tipHeight - maxDepth + 1)',
    to: 'const lowest = store.baseHeight',
    tests: '__tests__/spv/syncReorg'
  },
  {
    rule: 'sync: a competing branch is validated before the window is touched',
    file: `${T}/headers/syncHeaders.ts`,
    from: "} catch {\n    return { kind: 'invalid' }\n  }",
    to: '} catch {\n    // mutated: carry on with a partial, unvalidated branch\n  }',
    tests: '__tests__/spv/syncReorg'
  },
  {
    rule: 'strict: root checks never reach the remote',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: 'async isValidRootForHeight(root: string, height: number): Promise<boolean> {\n    if (this.options.strict) {',
    to: 'async isValidRootForHeight(root: string, height: number): Promise<boolean> {\n    if (false) {',
    tests: '__tests__/spv/strictChaintracks'
  },
  {
    rule: 'strict: an unverified cached root (extra) is never trusted',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: 'const verified = this.store?.verifiedRootForHeight(height)',
    to: 'const verified = this.store?.rootForHeight(height)',
    tests: '__tests__/spv/strictChaintracks'
  },
  {
    rule: 'strict: header lookups answer from the verified window only',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: "async findHeaderForHeight(height: number) {\n    if (this.options.strict) {",
    to: 'async findHeaderForHeight(height: number) {\n    if (false) {',
    tests: '__tests__/spv/strictChaintracks'
  },
  {
    rule: 'strict: the height comes from the verified window',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: "if (this.options.strict) return this.requireStore('currentHeight').tipHeight",
    to: '',
    tests: '__tests__/spv/strictChaintracks'
  },
  {
    rule: 'chain mode: an unrecognised value means spv',
    file: `${T}/spv/spvMode.ts`,
    from: "  return 'spv'\n}\n\n/** Registrable",
    to: "  return 'public'\n}\n\n/** Registrable",
    tests: '__tests__/spv/spvMode'
  },
  {
    rule: 'indexer guard: WhatsOnChain is blocked',
    file: `${T}/spv/spvMode.ts`,
    from: "  'whatsonchain.com',\n",
    to: '',
    tests: '__tests__/spv/spvMode'
  },
  {
    rule: 'indexer guard: an unparseable URL is blocked',
    file: `${T}/spv/spvMode.ts`,
    from: '  } catch {\n    return true\n  }\n  return BLOCKED_SUFFIXES',
    to: '  } catch {\n    return false\n  }\n  return BLOCKED_SUFFIXES',
    tests: '__tests__/spv/spvMode'
  },
  {
    rule: 'configureToolbox installs the guard in spv mode',
    file: `${T}/toolboxConfig.ts`,
    from: "current.chainMode === 'spv' ? installIndexerGuard",
    to: "false ? installIndexerGuard",
    tests: '__tests__/spv/spvMode'
  },
  {
    rule: 'services: proofs come from Arcade only',
    file: `${T}/spv/applySpvServices.ts`,
    from: '  keepArcadeOnly(s.getMerklePathServices)\n',
    to: '',
    tests: '__tests__/spv/spvServices'
  },
  {
    rule: 'services: blocked lookups answer with an error, not an empty result',
    file: `${T}/spv/applySpvServices.ts`,
    from: "(error, txid) => ({ txid, name: NO_INDEXER, error }),",
    to: "(error, txid) => ({ txid, name: NO_INDEXER }),",
    tests: '__tests__/spv/spvServices'
  },
  {
    rule: 'LIVE: the strict tracker refuses a root the verified chain does not hold (tampered BUMP is rejected)',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: 'if (verified !== undefined) return verified === root',
    to: 'if (verified !== undefined) return true',
    tests: '__tests__/spv/live/wallet',
    env: { SPV_LIVE: '1' }
  },
  {
    rule: 'strict: a height the chain lacks is a miss, never a yes',
    file: `${T}/headers/OfflineFirstChaintracks.ts`,
    from: '      this.lastMissHeight = height\n      return false\n    }\n    // Fast path',
    to: '      this.lastMissHeight = height\n      return true\n    }\n    // Fast path',
    tests: '__tests__/spv/strictChaintracks'
  },
  {
    rule: 'LIVE: the fetch guard refuses public indexers',
    file: `${T}/spv/spvMode.ts`,
    from: 'const url = urlOf(input)\n    if (isBlockedIndexerUrl(url)) {',
    to: 'const url = urlOf(input)\n    if (false) {',
    tests: '__tests__/spv/live/wallet',
    env: { SPV_LIVE: '1' }
  },
  {
    rule: 'LIVE: a proof Arcade reports is checked against the verified header (hashToHeader answers from the verified chain)',
    file: `${T}/spv/applySpvServices.ts`,
    from: "if (!header) throw new Error(`block ${hash} is not in the verified header chain`)",
    to: '',
    tests: '__tests__/spv/spvServices'
  },
  {
    rule: 'header setup: spv refuses a chain with no difficulty rules',
    file: `${T}/spv/headerSetup.ts`,
    from: "if (mode === 'spv' && spv.rules !== 'regtest') {",
    to: 'if (false) {',
    tests: '__tests__/spv/headerSetup'
  },
  {
    rule: 'header setup: regtest rules need an explicit anchor',
    file: `${T}/spv/headerSetup.ts`,
    from: "if (spv.rules === 'regtest' && !spv.anchor) {",
    to: 'if (false) {',
    tests: '__tests__/spv/headerSetup'
  },
  // ── https-only, Arcade API key, SSE, zero-conf ───────────────────────────────────────────────
  {
    rule: 'origin: plain http is allowed only to a local-development host',
    file: `${T}/spv/serviceOrigin.ts`,
    from: "return parsed.protocol === 'http:' && PRIVATE_HOST.test(parsed.hostname)",
    to: 'return true',
    tests: '__tests__/spv/serviceOrigin'
  },
  {
    rule: 'origin: an origin with credentials is refused',
    file: `${T}/spv/serviceOrigin.ts`,
    from: 'if (parsed.username || parsed.password) return false',
    to: '',
    tests: '__tests__/spv/serviceOrigin'
  },
  {
    rule: 'endpoints: the Arcade/chaintracks/SSE scheme is checked',
    file: `${T}/spv/spvMode.ts`,
    from: 'if (!isAllowedSpvOrigin(url)) {',
    to: 'if (false) {',
    tests: '__tests__/spv/serviceOrigin'
  },
  {
    rule: 'auth: a key that could split a header is refused',
    file: `${T}/spv/arcadeAuth.ts`,
    from: 'if (key.length > MAX_KEY || /[\\u0000-\\u001f\\u007f]/.test(key)) {',
    to: 'if (key.length > MAX_KEY) {',
    tests: '__tests__/spv/arcadeAuth'
  },
  {
    rule: 'auth: the raw chaintracks client sends the key',
    file: `${T}/spv/rawChaintracksClient.ts`,
    from: 'headers: this.authHeaders',
    to: 'headers: {}',
    tests: '__tests__/spv/arcadeAuth'
  },
  {
    rule: 'auth: the Arcade proof service sends the key',
    file: `${T}/spv/arcadeMerklePath.ts`,
    from: 'await fetcher(`${base}/tx/${txid.toLowerCase()}`, { headers })',
    to: 'await fetcher(`${base}/tx/${txid.toLowerCase()}`)',
    tests: '__tests__/spv/arcadeAuth'
  },
  {
    rule: 'auth: the broadcast service sends the key',
    file: `${T}/services/arcadeBroadcastProvider.ts`,
    from: '...arcadeAuthHeaders(apiKey)',
    to: '',
    tests: '__tests__/spv/arcadeAuth'
  },
  {
    rule: 'auth: the zero-conf status check sends the key',
    file: `${T}/spv/zeroConf.ts`,
    from: 'await o.fetcher(`${o.base}/tx/${txid}`, { headers: o.headers })',
    to: 'await o.fetcher(`${o.base}/tx/${txid}`)',
    tests: '__tests__/spv/zeroConf'
  },
  {
    rule: 'auth: LIVE, a wallet with the key reaches an Arcade that requires it',
    file: `${T}/spv/rawChaintracksClient.ts`,
    from: 'headers: this.authHeaders',
    to: 'headers: {}',
    tests: '__tests__/spv/live/auth',
    env: { SPV_LIVE: '1' }
  },
  {
    rule: 'sse: the event stream only ever goes to the Arcade events URL',
    file: `${T}/spv/spvEventSource.ts`,
    from: 'if (!(u === from || u.startsWith(`${from}?`))) {',
    to: 'if (false) {',
    tests: '__tests__/spv/spvEventSource'
  },
  {
    rule: 'sse: the events URL moves to the SSE listener',
    file: `${T}/spv/spvEventSource.ts`,
    from: 'super(`${to}${u.slice(from.length)}`, options)',
    to: 'super(u, options)',
    tests: '__tests__/spv/spvEventSource'
  },
  {
    rule: 'sse: no SSE URL means no push class',
    file: `${T}/spv/spvEventSource.ts`,
    from: 'if (!sseUrl) return undefined',
    to: "if (!sseUrl) sseUrl = 'http://localhost:1'",
    tests: '__tests__/spv/spvEventSource'
  },
  {
    rule: 'sse: an empty API key is made absent (the toolbox SSE client rejects an empty one)',
    file: `${T}/spv/applySpvServices.ts`,
    from: 'if (arcadeConfig && !arcadeConfig.apiKey) arcadeConfig.apiKey = undefined',
    to: "if (arcadeConfig && !arcadeConfig.apiKey) arcadeConfig.apiKey = ''",
    tests: '__tests__/spv/spvServices'
  },
  {
    rule: 'zero-conf: an unmined payment Arcade has not seen is refused',
    file: `${T}/spv/zeroConf.ts`,
    from: 'if (bad >= 0) {',
    to: 'if (false) {',
    tests: '__tests__/spv/zeroConf'
  },
  {
    rule: 'zero-conf: a conflicting payment is refused at once',
    file: `${T}/spv/zeroConf.ts`,
    from: "if (CONFLICT.has(st)) return { ok: false, reason: `Arcade reports ${st}` }",
    to: '',
    tests: '__tests__/spv/zeroConf'
  },
  {
    rule: 'zero-conf: only SEEN or better counts as seen',
    file: `${T}/spv/zeroConf.ts`,
    from: "const SEEN = new Set(['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'SEEN_MULTIPLE_NODES', 'MINED', 'IMMUTABLE'])",
    to: "const SEEN = new Set(['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'SEEN_MULTIPLE_NODES', 'MINED', 'IMMUTABLE', 'ACCEPTED_BY_NETWORK', 'RECEIVED'])",
    tests: '__tests__/spv/zeroConf'
  },
  {
    rule: 'sse: LIVE, events come from the SSE listener, not the API port',
    file: `${T}/spv/spvEventSource.ts`,
    from: 'super(`${to}${u.slice(from.length)}`, options)',
    to: 'super(u, options)',
    tests: '__tests__/spv/live/sse',
    env: { SPV_LIVE: '1' }
  },
  {
    rule: 'zero-conf: LIVE, the wallet refuses an unseen and a conflicting payment',
    file: `${T}/spv/zeroConf.ts`,
    from: 'if (bad >= 0) {',
    to: 'if (false) {',
    tests: '__tests__/spv/live/zeroconf',
    env: { SPV_LIVE: '1' }
  },
  {
    rule: 'monitor headers: a header must satisfy the chain rules',
    file: `${T}/spv/monitorHeaders.ts`,
    from: '    rules.validate({ height: header.height, hash: header.hash, bits: header.bits, time: header.time })\n',
    to: '',
    tests: '__tests__/spv/monitorHeaders'
  },
  {
    rule: "monitor headers: a header's hash must be the hash of its fields",
    file: `${T}/spv/monitorHeaders.ts`,
    from: '    validateHeaderFormat(header as never)\n',
    to: '',
    tests: '__tests__/spv/monitorHeaders'
  },
  {
    rule: 'monitor headers: the NewHeader task reads the tip under the chain rules',
    file: `${T}/spv/monitorHeaders.ts`,
    from: '  if (newHeader) {',
    to: '  if (false) {',
    tests: '__tests__/spv/monitorHeaders'
  }
]

const only = process.argv.slice(2).map(Number)
const originals = new Map()
const restoreAll = () => {
  for (const [file, text] of originals) writeFileSync(file, text)
  originals.clear()
}
process.on('SIGINT', () => {
  restoreAll()
  process.exit(130)
})

let bad = 0
controls.forEach((c, i) => {
  const n = i + 1
  if (only.length && !only.includes(n)) return
  const text = readFileSync(c.file, 'utf8')
  // Source files may be CRLF (the published toolbox is); match and replace in the file's own endings.
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const from = c.from.replace(/\n/g, eol)
  const to = c.to.replace(/\n/g, eol)
  const count = text.split(from).length - 1
  if (count !== 1) {
    console.log(`#${n} ERROR  "${c.rule}": expected 1 occurrence of the target text, found ${count}`)
    bad++
    return
  }
  originals.set(c.file, text)
  try {
    writeFileSync(c.file, text.replace(from, () => to))
    const r = spawnSync('npx', ['jest', c.tests, '--silent'], { encoding: 'utf8', shell: true, env: { ...process.env, ...(c.env ?? {}) } })
    const failed = r.status !== 0
    console.log(`#${n} ${failed ? 'RED (good)' : 'GREEN (BAD: test does not cover the rule)'}  ${c.rule}`)
    if (!failed) bad++
  } finally {
    restoreAll()
  }
})
console.log(bad === 0 ? '\nAll negative controls went red.' : `\n${bad} control(s) did not behave.`)
process.exit(bad === 0 ? 0 : 1)
