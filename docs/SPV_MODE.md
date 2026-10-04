# spv chain mode

An opt-in mode in which the wallet gets chain data **only from one Arcade deployment** and **checks headers and merkle proofs itself**, instead of trusting a remote answer. Default behaviour (`EXPO_PUBLIC_CHAIN_MODE` unset or `public`) is unchanged.

**Current state, stated plainly.** Everything below was built test-first and exercised against the local regtest stack ([spv-testnet](https://github.com/BOLT-Association/spv-testnet): Teranode + merkle-service + Arcade) with a **headless** wallet. The Expo app itself has **not** been run in spv mode on a device or emulator. The difficulty rules that exist are **regtest-only**: spv on `main`, `test` or `teratest` with the toolbox's default rules is refused at wallet build, because retargeting is not implemented for them (see *Before this is usable on mainnet / testnet*).

## What it does

- **A verified header chain** (`HeaderStore` + `syncHeaders`, with `chainRules.ts`): linkage from a pinned anchor, proof-of-work against the chain's own rules, **most-work reorg selection** (a competing branch is fetched into a scratch store, validated with the same rules, and followed only if it has strictly more work and is no deeper than 144; otherwise the store is untouched and the reason is reported). Every stored header is re-validated when the store opens; a tampered window is dropped, not partly kept.
- **Strict chain tracker** (`OfflineFirstChaintracks` with `{ strict: true }`): roots, headers, heights and the tip come from the verified chain only. A height it does not hold is a refusal (a miss for root checks, an error for header lookups). It never asks the remote and never trusts the `-extra` root cache. `window.CWI.getHeaderForHeight` / `getHeight` end here too.
- **Proofs are stored only once the wallet's own chain verifies them.** The toolbox authenticates a proof's root with the chain tracker before storing it (`EntityProvenTx.fromReq`); in spv mode that tracker is the strict one. A proof for a block the chain does not hold yet comes back as an error with no proof, so the request stays pending and is retried after the next header sync. Nothing unverified is stored. (The toolbox's built-in Arcade proof provider and `hashToHeader` check proof-of-work against the **mainnet** limit, so in spv mode `getMerklePath` is `arcadeMerklePath.ts` and `hashToHeader` answers from the verified chain.)
- **Arcade only.** Broadcast, status and proofs keep only Arcade providers. Raw-tx, UTXO and address-history lookups, which Arcade cannot answer, return an explicit **error** (never an empty result). A fetch guard rejects any request to a public indexer host (WhatsOnChain, TAAL, GorillaPool, Bitails), so a call site the wiring missed becomes a network error.
- **Fails closed.** An unrecognised `EXPO_PUBLIC_CHAIN_MODE` means spv, not public. spv needs an Arcade and a chaintracks URL for the chain, and neither may be a public indexer. spv refuses a chain that has no difficulty rules.

## Configuration

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_CHAIN_MODE` | unset / `public`: unchanged. Anything else: spv. |
| `EXPO_PUBLIC_[TEST_\|TERATEST_]ARC_URL` | Arcade API base (no `/v1`; `POST /tx` answers 202). Required in spv. |
| `EXPO_PUBLIC_[TEST_\|TERATEST_]CHAINTRACKS_URL` | Arcade chaintracks base, e.g. `http://<host>:8083/chaintracks/v1`. Required in spv. |
| `EXPO_PUBLIC_SPV_RULES` | `regtest` (the only rule set implemented): no retargeting, every header must declare `0x207fffff`. |
| `EXPO_PUBLIC_SPV_ANCHOR_HEIGHT`, `EXPO_PUBLIC_SPV_ANCHOR_HASH` | Trust anchor of the header window, together. Required with `regtest` (the regtest genesis, `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`). |

Local regtest runs through the `teratest` slot: `EXPO_PUBLIC_DEFAULT_CHAIN=teratest`. From an emulator or device use the host's LAN IP, not `localhost`.

## How it is carried

The wallet core is a dependency (`@bsv/expo-wallet-toolbox`), so the change is a `patch-package` patch: `patches/@bsv+expo-wallet-toolbox+0.11.0+001+spv-hardening.patch`, next to the maintainers' existing `0.10.0` patch (UI files only, no overlap). New code is in `core/spv/` and `core/headers/chainRules.ts`; edits to existing toolbox files are `headerStore.ts`, `syncHeaders.ts`, `OfflineFirstChaintracks.ts`, `toolboxConfig.ts` and a few lines in `context/WalletContext.tsx`. The app side is `utils/spvEnv.ts` and the env mapping in `app/_layout.tsx`. A toolbox upgrade means rebasing the patch; `npm ci` in a scratch directory reproduces the patched tree exactly.

## Tests

```bash
npx jest __tests__/spv                                   # unit tests, no network
node scripts/spv-negative-controls.mjs                   # disables each rule in turn; every test must go red
# live, against the running spv-testnet stack (needs Docker; serial, because the reorg test rewrites the chain):
SPV_LIVE=1 npx jest __tests__/spv/live --runInBand
```

The negative controls edit files under `node_modules` and restore them (also on Ctrl-C). The live tests stop the stack's `cb-block-generator` for the reorg test and start it again. They run the real `Wallet` on an in-memory SQLite database (`node:sqlite` behind an `expo-sqlite` shim), so nothing touches a real wallet or data directory.

Live results (regtest): header sync from genesis equals the node's own roots; a chaintracks that forges a merkle root is rejected and the verified prefix kept; a real reorg is followed to the heavier branch; a BEEF for a block the wallet's chain has not reached is refused and accepted after the wallet's own sync; a BEEF with a tampered BUMP is rejected; a spend through Arcade is broadcast, and its proof is **not** stored before the wallet's chain holds the block and **is** stored after (root equal to the node's); a lying Arcade serving a tampered BUMP gets no proof stored; the wallet only ever contacted the configured Arcade and chaintracks.

## Known gaps

- **Mainnet / testnet rules.** Difficulty adjustment (DAA), median-time-past and per-network checkpoints are not implemented. This is where they go: `core/headers/chainRules.ts` (`rulesForChain`) and `core/spv/headerSetup.ts`. Until then spv is regtest-only. Pointing at a real Arcade needs those, Arcade authentication (the raw chaintracks client and the Arcade proof service send no API key), an `https`-only check on the Arcade and chaintracks URLs (spv only refuses indexer hosts today), and a check of what a real deployment's fee policy reports.
- **Public mode is unchanged**, including the page-facing `getHeaderForHeight` / `getHeight` and `isValidRootForHeight`'s network fallback. The mode switch is opt-in by design.
- **Push (SSE) is not exercised.** Arcade serves SSE from a separate listener (`:8082` in spv-testnet); the toolbox's `TaskArcadeSSE` has not been pointed at it. Proofs arrive by polling.
- **Zero-conf** (spending a received output before it is mined) is not implemented here; the toolbox spends only what its BEEF check accepts.
- **Address recovery and PeerPay** depend on indexer lookups and MessageBox; recovery from a mnemonic cannot discover funds in spv mode.
- **Not run on a device or emulator.**
- **`eas.json` commits WhatsOnChain API keys** (lines 51, 54, 57). Reported, not changed here.
- **Not mine:** `__tests__/vault/guard.test.ts` fails on a clean checkout (5 tests); it is unrelated and left alone.
