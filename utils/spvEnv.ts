import type { SpvOptions } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'

type Env = Record<string, string | undefined>

/**
 * spv header options from the host's env. Takes the env as an argument so it can
 * be tested; the caller passes literal `process.env.EXPO_PUBLIC_*` reads (Expo
 * only inlines that exact shape), see app/_layout.tsx.
 *
 * A half-stated anchor is an error, not a default: a height with no hash (or the
 * reverse) is a misconfigured trust root, and ignoring it would silently fall
 * back to a different one.
 */
export function spvOptionsFromEnv(env: Env): SpvOptions | undefined {
  const rules = env.EXPO_PUBLIC_SPV_RULES?.trim()
  const height = env.EXPO_PUBLIC_SPV_ANCHOR_HEIGHT?.trim()
  const hash = env.EXPO_PUBLIC_SPV_ANCHOR_HASH?.trim()
  const out: SpvOptions = {}
  if (rules) out.rules = rules as SpvOptions['rules']
  if (height || hash) {
    if (!height || !hash) {
      throw new Error('spv anchor needs both EXPO_PUBLIC_SPV_ANCHOR_HEIGHT and EXPO_PUBLIC_SPV_ANCHOR_HASH')
    }
    if (!/^\d+$/.test(height)) throw new Error(`EXPO_PUBLIC_SPV_ANCHOR_HEIGHT must be a whole number, got "${height}"`)
    out.anchor = { height: Number(height), hash }
  }
  return Object.keys(out).length === 0 ? undefined : out
}
