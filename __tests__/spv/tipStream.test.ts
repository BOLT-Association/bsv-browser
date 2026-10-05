import { startTipStream, tipStreamUrl, TIP_STREAM_IDLE_MS, TIP_STREAM_RECONNECT_MS } from '@bsv/expo-wallet-toolbox/core/spv/tipStream'

type Listener = (event?: unknown) => void

class FakeEventSource {
  static all: FakeEventSource[] = []
  static get last() {
    return FakeEventSource.all[FakeEventSource.all.length - 1]
  }
  listeners: Record<string, Listener[]> = {}
  closed = false
  constructor(
    public url: string,
    public options: Record<string, any>
  ) {
    FakeEventSource.all.push(this)
  }
  addEventListener(type: string, cb: Listener) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  close() {
    this.closed = true
  }
  emit(type: string, event?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(event)
  }
}

/** A timer the test advances by hand. */
function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = []
  let next = 1
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      pending.push({ fn, ms, id })
      return id
    },
    clearTimeout: (id: unknown) => {
      const i = pending.findIndex(p => p.id === id)
      if (i >= 0) pending.splice(i, 1)
    },
    fire: () => pending.splice(0).forEach(p => p.fn())
  }
}

const URL = 'http://localhost:8083/chaintracks/v2/tip/stream'
const TIP = '{"height":398,"hash":"639dce7e8fcfe494d64efe9a17cecf19c0d41054ea8abcf7dbd14daaaa6fc988"}'

beforeEach(() => {
  FakeEventSource.all = []
})

describe('tipStreamUrl', () => {
  it('is the v2 tip stream of the configured chaintracks, whichever version the wallet reads headers from', () => {
    expect(tipStreamUrl('http://10.0.2.2:8083/chaintracks/v1')).toBe('http://10.0.2.2:8083/chaintracks/v2/tip/stream')
    expect(tipStreamUrl('http://10.0.2.2:8083/chaintracks/v2')).toBe('http://10.0.2.2:8083/chaintracks/v2/tip/stream')
    expect(tipStreamUrl('https://arcade.example.com/chaintracks/v1/')).toBe(
      'https://arcade.example.com/chaintracks/v2/tip/stream'
    )
    expect(tipStreamUrl('https://arcade.example.com/chaintracks')).toBe(
      'https://arcade.example.com/chaintracks/v2/tip/stream'
    )
  })

  it('refuses an origin spv mode does not allow (plain http off a local-development host, a public indexer)', () => {
    expect(() => tipStreamUrl('http://arcade.example.com/chaintracks/v1')).toThrow(/tip stream/)
    expect(() => tipStreamUrl('https://api.whatsonchain.com/v1')).toThrow(/tip stream/)
    expect(() => tipStreamUrl('nonsense')).toThrow(/tip stream/)
  })
})

describe('startTipStream', () => {
  it('opens the stream with the given headers and leaves reconnecting to itself', () => {
    startTipStream({ EventSource: FakeEventSource as never, url: URL, headers: { Authorization: 'Bearer k' }, onTip: () => {} })
    expect(FakeEventSource.all).toHaveLength(1)
    expect(FakeEventSource.last.url).toBe(URL)
    expect(FakeEventSource.last.options.headers).toEqual({ Authorization: 'Bearer k' })
    // react-native-sse reconnects on its own unless told not to; one reconnect policy, ours.
    expect(FakeEventSource.last.options.pollingInterval).toBe(0)
  })

  it('calls onTip for every frame: the one sent on connect and each new block', () => {
    const onTip = jest.fn()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip })
    FakeEventSource.last.emit('message', { data: TIP })
    FakeEventSource.last.emit('message', { data: TIP })
    expect(onTip).toHaveBeenCalledTimes(2)
  })

  it('treats a frame as a trigger only: what it carries is never used, so a malformed one still triggers', () => {
    const onTip = jest.fn()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip })
    FakeEventSource.last.emit('message', { data: 'not json' })
    expect(onTip).toHaveBeenCalledTimes(1)
    expect(onTip).toHaveBeenCalledWith()
  })

  it('a throwing onTip does not break the stream', () => {
    const onTip = jest.fn(() => {
      throw new Error('boom')
    })
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip })
    expect(() => FakeEventSource.last.emit('message', { data: TIP })).not.toThrow()
    FakeEventSource.last.emit('message', { data: TIP })
    expect(onTip).toHaveBeenCalledTimes(2)
  })

  it('after an error closes the stream and opens a new one after the reconnect delay', () => {
    const t = fakeTimers()
    const onTip = jest.fn()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const first = FakeEventSource.last
    first.emit('error', { message: 'connection lost' })
    expect(first.closed).toBe(true)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(t.pending.map(p => p.ms)).toEqual([TIP_STREAM_RECONNECT_MS])
    t.fire()
    expect(FakeEventSource.all).toHaveLength(2)
    // The new stream is live, the old one is not.
    first.emit('message', { data: TIP })
    expect(onTip).not.toHaveBeenCalled()
    FakeEventSource.last.emit('message', { data: TIP })
    expect(onTip).toHaveBeenCalledTimes(1)
  })

  it('schedules one reconnect however many errors and closes one stream reports', () => {
    const t = fakeTimers()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const first = FakeEventSource.last
    first.emit('error')
    first.emit('error')
    first.emit('close')
    expect(t.pending).toHaveLength(1)
  })

  it('a constructor that throws is retried after the delay, not thrown at the caller', () => {
    const t = fakeTimers()
    let fail = true
    class Flaky extends FakeEventSource {
      constructor(url: string, options: Record<string, any>) {
        if (fail) throw new Error('no network module')
        super(url, options)
      }
    }
    expect(() =>
      startTipStream({ EventSource: Flaky as never, url: URL, onTip: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    ).not.toThrow()
    expect(FakeEventSource.all).toHaveLength(0)
    fail = false
    t.fire()
    expect(FakeEventSource.all).toHaveLength(1)
  })

  it('reopens a stream that has gone silent: a dropped connection can look exactly like a quiet chain', () => {
    const t = fakeTimers()
    const onTip = jest.fn()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const first = FakeEventSource.last
    // The watchdog is armed on open; nothing arrives, no error is reported.
    expect(t.pending.map(p => p.ms)).toEqual([TIP_STREAM_IDLE_MS])
    t.fire()
    expect(first.closed).toBe(true)
    expect(FakeEventSource.all).toHaveLength(2)
    FakeEventSource.last.emit('message', { data: TIP })
    expect(onTip).toHaveBeenCalledTimes(1)
  })

  it('a frame restarts the silence watchdog instead of stacking another', () => {
    const t = fakeTimers()
    startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    FakeEventSource.last.emit('message', { data: TIP })
    FakeEventSource.last.emit('message', { data: TIP })
    expect(t.pending.map(p => p.ms)).toEqual([TIP_STREAM_IDLE_MS])
    expect(FakeEventSource.all).toHaveLength(1)
  })

  it('stop closes the stream, cancels a pending reconnect and silences later frames', () => {
    const t = fakeTimers()
    const onTip = jest.fn()
    const stop = startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const first = FakeEventSource.last
    first.emit('error')
    stop()
    expect(t.pending).toHaveLength(0)
    t.fire()
    expect(FakeEventSource.all).toHaveLength(1)

    const stop2 = startTipStream({ EventSource: FakeEventSource as never, url: URL, onTip, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const second = FakeEventSource.last
    stop2()
    expect(second.closed).toBe(true)
    second.emit('message', { data: TIP })
    second.emit('error')
    expect(onTip).not.toHaveBeenCalled()
    expect(t.pending).toHaveLength(0)
  })
})
