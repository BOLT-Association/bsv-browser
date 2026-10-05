import { makeSpvEventSourceClass } from '@bsv/expo-wallet-toolbox/core/spv/spvEventSource'
import { configureToolbox, getSpvOptions } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { spvOptionsFromEnv } from '../../utils/spvEnv'

class FakeEventSource {
  static last: FakeEventSource
  constructor(
    public url: string,
    public options: Record<string, unknown>
  ) {
    FakeEventSource.last = this
  }
  addEventListener() {}
  close() {}
}

const ARC = 'http://192.168.1.20:8080'
const SSE = 'http://192.168.1.20:8082'

describe('makeSpvEventSourceClass', () => {
  it('has no class (SSE off, polling only) when there is no SSE URL', () => {
    expect(makeSpvEventSourceClass(FakeEventSource as never, ARC, undefined)).toBeUndefined()
    expect(makeSpvEventSourceClass(FakeEventSource as never, ARC, '')).toBeUndefined()
  })

  it('moves the toolbox events URL from the Arcade API to the SSE listener, keeping the token and the headers', () => {
    const Cls = makeSpvEventSourceClass(FakeEventSource as never, ARC, SSE)!
    new Cls(`${ARC}/events?callbackToken=abc%20def`, {
      headers: { Authorization: 'Bearer k', 'Last-Event-ID': '7' },
      debug: true
    })
    expect(FakeEventSource.last.url).toBe(`${SSE}/events?callbackToken=abc%20def`)
    expect(FakeEventSource.last.options.headers).toEqual({ Authorization: 'Bearer k', 'Last-Event-ID': '7' })
  })

  it('tolerates trailing slashes on either base', () => {
    const Cls = makeSpvEventSourceClass(FakeEventSource as never, `${ARC}/`, `${SSE}/`)!
    new Cls(`${ARC}/events?callbackToken=t`, {})
    expect(FakeEventSource.last.url).toBe(`${SSE}/events?callbackToken=t`)
  })

  it('refuses any URL that is not the Arcade events URL, so the callback token and key cannot go elsewhere', () => {
    const Cls = makeSpvEventSourceClass(FakeEventSource as never, ARC, SSE)!
    expect(() => new Cls('https://evil.example.com/events?callbackToken=t', {})).toThrow()
    expect(() => new Cls(`${ARC}/other?callbackToken=t`, {})).toThrow()
    expect(() => new Cls(`${ARC}.evil.com/events?callbackToken=t`, {})).toThrow()
  })
})

describe('sseUrl option', () => {
  afterEach(() => configureToolbox({ backupUrl: null }))
  it('is carried by the config', () => {
    configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { sseUrl: 'http://localhost:8082' } })
    expect(getSpvOptions().sseUrl).toBe('http://localhost:8082')
  })
  it('is refused when it is not an https or local-development origin', () => {
    expect(() =>
      configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { sseUrl: 'http://arcade.example.com:8082' } })
    ).toThrow(/sseUrl/)
    expect(() => configureToolbox({ backupUrl: null, chainMode: 'spv', spv: { sseUrl: 'nonsense' } })).toThrow(/sseUrl/)
  })
  it('is read from the environment', () => {
    expect(spvOptionsFromEnv({ EXPO_PUBLIC_SPV_SSE_URL: 'http://localhost:8082' })).toEqual({
      sseUrl: 'http://localhost:8082'
    })
    expect(spvOptionsFromEnv({ EXPO_PUBLIC_SPV_SSE_URL: '' })).toBeUndefined()
  })
})
