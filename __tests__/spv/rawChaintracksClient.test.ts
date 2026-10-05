import { RawChaintracksClient } from '@bsv/expo-wallet-toolbox/core/spv/rawChaintracksClient'

const BASE = 'http://192.168.1.20:8083/chaintracks/v1'

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = []
  const fn = (async (input: string) => {
    calls.push(input)
    const path = input.slice(BASE.length)
    const r = routes[path]
    if (!r) return { ok: false, status: 404, text: async () => 'not found' } as Response
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const HDR = 'ab'.repeat(80)

describe('RawChaintracksClient', () => {
  it('reads the present height', async () => {
    const { fn } = fakeFetch({ '/getPresentHeight': { body: { status: 'success', value: 982 } } })
    expect(await new RawChaintracksClient(BASE, fn).getPresentHeight()).toBe(982)
  })

  it('reads headers as hex without judging them (the header store does that)', async () => {
    const { fn, calls } = fakeFetch({ '/getHeaders?height=5&count=1': { body: { status: 'success', value: HDR } } })
    expect(await new RawChaintracksClient(BASE, fn).getHeaders(5, 1)).toBe(HDR)
    expect(calls).toEqual([`${BASE}/getHeaders?height=5&count=1`])
  })

  it('accepts a base URL with a trailing slash', async () => {
    const { fn } = fakeFetch({ '/getPresentHeight': { body: { status: 'success', value: 3 } } })
    expect(await new RawChaintracksClient(BASE + '/', fn).getPresentHeight()).toBe(3)
  })

  it.each([
    ['a non-success status', { status: 'error', description: 'no' }],
    ['no value', { status: 'success' }],
    ['a non-integer height', { status: 'success', value: 'many' }],
    ['a negative height', { status: 'success', value: -1 }]
  ])('refuses %s as the present height', async (_name, body) => {
    const { fn } = fakeFetch({ '/getPresentHeight': { body } })
    await expect(new RawChaintracksClient(BASE, fn).getPresentHeight()).rejects.toThrow()
  })

  it.each([
    ['non-hex', 'zz'.repeat(80)],
    ['a length that is not a whole number of headers', 'ab'.repeat(79)],
    ['an odd number of hex digits', HDR + 'a']
  ])('refuses %s as headers', async (_name, value) => {
    const { fn } = fakeFetch({ '/getHeaders?height=1&count=1': { body: { status: 'success', value } } })
    await expect(new RawChaintracksClient(BASE, fn).getHeaders(1, 1)).rejects.toThrow()
  })

  it('an empty answer means no headers, not an error', async () => {
    const { fn } = fakeFetch({ '/getHeaders?height=1&count=1': { body: { status: 'success', value: '' } } })
    expect(await new RawChaintracksClient(BASE, fn).getHeaders(1, 1)).toBe('')
  })

  it('refuses more headers than were asked for', async () => {
    const { fn } = fakeFetch({ '/getHeaders?height=1&count=1': { body: { status: 'success', value: HDR + HDR } } })
    await expect(new RawChaintracksClient(BASE, fn).getHeaders(1, 1)).rejects.toThrow(/more/i)
  })

  it('an HTTP error is an error', async () => {
    const { fn } = fakeFetch({ '/getPresentHeight': { status: 500, body: 'boom' } })
    await expect(new RawChaintracksClient(BASE, fn).getPresentHeight()).rejects.toThrow(/500/)
  })

  it('rejects arguments that are not whole non-negative numbers', async () => {
    const { fn } = fakeFetch({})
    const c = new RawChaintracksClient(BASE, fn)
    await expect(c.getHeaders(-1, 1)).rejects.toThrow()
    await expect(c.getHeaders(1, 0)).rejects.toThrow()
    await expect(c.getHeaders(1.5, 1)).rejects.toThrow()
  })

  it('does not support reorg events and says so, so nothing tries to subscribe', async () => {
    const { fn } = fakeFetch({})
    const c = new RawChaintracksClient(BASE, fn)
    expect(c.supportsReorgEvents).toBe(false)
    await expect(c.subscribeHeaders(() => {})).rejects.toThrow()
  })
})
