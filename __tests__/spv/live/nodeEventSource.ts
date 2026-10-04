/**
 * A minimal EventSource for the live tests, over node:http (the app uses
 * react-native-sse, which needs React Native's networking). Same surface the
 * toolbox's ArcSSEClient uses: constructor(url, { headers }), addEventListener for
 * 'open' | 'status' | 'error', close(). Events carry `data` and `lastEventId`.
 */
import http from 'node:http'
import https from 'node:https'

type Listener = (event: any) => void

export class NodeEventSource {
  /** Every URL and header set a connection was opened with, for assertions. */
  static opened: { url: string; headers: Record<string, string> }[] = []
  private listeners = new Map<string, Listener[]>()
  private req?: http.ClientRequest
  private closed = false

  constructor(url: string, options: { headers?: Record<string, string> } = {}) {
    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...(options.headers ?? {}) }
    NodeEventSource.opened.push({ url, headers: { ...headers } })
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    this.req = lib.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        this.emit('error', { message: `HTTP ${res.statusCode}` })
        res.resume()
        return
      }
      this.emit('open', {})
      let buf = ''
      let id = ''
      let type = 'message'
      let data: string[] = []
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + (buf[nl] === '\r' ? 2 : 1))
          if (line === '') {
            if (data.length) this.emit(type, { type, data: data.join('\n'), lastEventId: id })
            type = 'message'
            data = []
          } else if (line.startsWith(':')) {
            // comment / keepalive
          } else {
            const i = line.indexOf(':')
            const field = i < 0 ? line : line.slice(0, i)
            const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
            if (field === 'event') type = value
            else if (field === 'data') data.push(value)
            else if (field === 'id') id = value
          }
        }
      })
      res.on('end', () => this.emit('error', { message: 'stream ended' }))
      res.on('error', e => this.emit('error', { message: e.message }))
    })
    this.req.on('error', e => this.emit('error', { message: e.message }))
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }

  close(): void {
    this.closed = true
    this.req?.destroy()
  }

  private emit(type: string, event: any): void {
    if (process.env.SPV_LIVE_DEBUG) console.log(`[NodeEventSource] ${type} ${JSON.stringify(event).slice(0, 160)}`)
    if (this.closed) return
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}
