import { isAllowedSpvOrigin } from '@bsv/expo-wallet-toolbox/core/spv/serviceOrigin'
import { assertSpvEndpoints } from '@bsv/expo-wallet-toolbox/core/spv/spvMode'
import { isAllowedServiceOrigin } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'

const ALLOWED = [
  'https://arcade.example.com',
  'https://arcade.example.com:8443/chaintracks/v1',
  'http://localhost:8080',
  'http://127.0.0.1:8083/chaintracks/v1',
  'http://10.0.2.2:8080',
  'http://10.1.2.3',
  'http://192.168.1.20:8080',
  'http://172.16.0.5',
  'http://172.31.255.1'
]
const REFUSED = [
  'http://arcade.example.com',
  'http://8.8.8.8:8080',
  'http://172.32.0.1',
  'http://172.15.0.1',
  'http://192.169.1.1',
  'http://localhost.evil.com',
  'http://10.0.0.1.evil.com',
  'https://user:pw@arcade.example.com',
  'http://user@localhost:8080',
  'ftp://arcade.example.com',
  'ws://localhost:8080',
  'not a url',
  ''
]

describe('isAllowedSpvOrigin', () => {
  it.each(ALLOWED)('allows %s', url => expect(isAllowedSpvOrigin(url)).toBe(true))
  it.each(REFUSED)('refuses %p', url => expect(isAllowedSpvOrigin(url)).toBe(false))

  it('agrees with the toolbox rule for backup and Mandala origins (the two must not drift)', () => {
    for (const u of [...ALLOWED, ...REFUSED]) {
      let parsed: URL
      try {
        parsed = new URL(u)
      } catch {
        continue
      }
      expect(isAllowedSpvOrigin(u)).toBe(isAllowedServiceOrigin(parsed))
    }
  })
})

describe('assertSpvEndpoints checks the scheme', () => {
  const ok = { arcUrl: 'https://arcade.example.com', chaintracksUrl: 'https://arcade.example.com/chaintracks/v1' }
  it('accepts https and private-network http', () => {
    expect(() => assertSpvEndpoints('teratest', ok)).not.toThrow()
    expect(() =>
      assertSpvEndpoints('teratest', { arcUrl: 'http://192.168.1.20:8080', chaintracksUrl: 'http://192.168.1.20:8083/chaintracks/v1' })
    ).not.toThrow()
  })
  it('refuses plain http to a public host, naming https', () => {
    expect(() => assertSpvEndpoints('main', { ...ok, arcUrl: 'http://arcade.example.com' })).toThrow(/https/i)
    expect(() => assertSpvEndpoints('main', { ...ok, chaintracksUrl: 'http://arcade.example.com/chaintracks/v1' })).toThrow(/https/i)
  })
  it('refuses credentials in a URL', () => {
    expect(() => assertSpvEndpoints('main', { ...ok, arcUrl: 'https://u:p@arcade.example.com' })).toThrow()
  })
  it('checks the SSE URL too, when there is one', () => {
    expect(() => assertSpvEndpoints('main', { ...ok, sseUrl: 'https://arcade.example.com:8082' })).not.toThrow()
    expect(() => assertSpvEndpoints('main', { ...ok, sseUrl: 'http://arcade.example.com:8082' })).toThrow(/https/i)
    expect(() => assertSpvEndpoints('main', { ...ok, sseUrl: 'https://api.whatsonchain.com' })).toThrow(/indexer/i)
  })
})
