/**
 * Cross-device link: phone remote / talent display ↔ prompter host.
 *
 * 1. Join the room on the relay over a WebSocket.
 * 2. Each guest (remote, display) offers a WebRTC data channel to the host;
 *    SDP and ICE travel as `{"t":"sig"}` frames through the relay.
 * 3. Once the channel opens, LinkMessages flow peer-to-peer (status `p2p`) and
 *    the relay only sees the room's presence frames.
 * 4. If the channel does not open within ~5 s, or drops later, messages are
 *    relayed over the WebSocket instead (status `relay`) and the guest keeps
 *    retrying WebRTC in the background.
 *
 * The topology is a star: the host keeps one RTCPeerConnection per guest;
 * guests only ever talk to the host. The WebSocket reconnects with backoff,
 * is health-checked with a heartbeat, and is revived immediately when a phone
 * wakes up (visibilitychange) or comes back online.
 */

import type { Link, LinkMessage, LinkRole, LinkStatus } from '../core/contracts'
import { normalizeRoomCode, randomPeerId } from './code'
import { P2P_TIMEOUT_MS, RELAY_URL } from './config'
import { createEmitter } from './emitter'
import { isLinkRole } from './message'
import { PeerChannel, parseSignal, type RTCPeerConnectionCtor, type SignalData } from './peer'
import { Reassembler, toFrames } from './wire'

export type WebSocketCtor = new (url: string) => WebSocket

/** Close codes sent by the relay (see crates/relay/src/protocol.rs). */
export const RelayClose = {
  REPLACED: 4000,
  BAD_REQUEST: 4400,
  IDLE: 4408,
  ROOM_FULL: 4409,
  RATE_LIMITED: 4429,
} as const

export interface RemoteLinkOptions {
  code: string
  role: LinkRole
  relayUrl?: string
  /** Shown to the host in the hello message. */
  name?: string
  /** Stable id for this tab; defaults to one kept in sessionStorage. */
  peerId?: string
  /** Injectables (tests, non-browser hosts). `RTCPeerConnection: null` disables WebRTC. */
  WebSocket?: WebSocketCtor
  RTCPeerConnection?: RTCPeerConnectionCtor | null
  p2pTimeoutMs?: number
  heartbeatMs?: number
  /** Where to listen for visibility/online events; defaults to the page. */
  events?: { document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>; window?: Pick<Window, 'addEventListener' | 'removeEventListener'> }
}

export interface RemoteLink extends Link {
  readonly code: string
  readonly role: LinkRole
  /** This tab's peer id in the room (assigned before the first connect). */
  readonly peerId: string
  /** Counterparts and how each is reached; for diagnostics and UI. */
  peers(): Array<{ id: string; role: LinkRole; via: 'p2p' | 'relay' | 'connecting' }>
  /** Reconnect right away (e.g. from a "retry" button). */
  reconnect(): void
}

type Mode = 'pending' | 'p2p' | 'relay'

interface Counterpart {
  id: string
  role: LinkRole
  mode: Mode
  /** Still in the room according to the relay. */
  present: boolean
  channel: PeerChannel | null
  session: string | null
  timer: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  attempts: number
  /** Guest only: hello already sent to this host session. */
  greeted: boolean
  inbox: Reassembler
}

const PING = '{"t":"ping"}'
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000]
const MAX_P2P_RETRIES = 3
const STATE_MIN_GAP_MS = 50

const storageKey = (role: LinkRole) => `deskprompter:peer:${role}`

function defaultPeerId(role: LinkRole): string {
  try {
    const saved = sessionStorage.getItem(storageKey(role))
    if (saved && /^[a-z0-9]{12}$/.test(saved)) return saved
    const id = randomPeerId()
    sessionStorage.setItem(storageKey(role), id)
    return id
  } catch {
    return randomPeerId()
  }
}

export function createRemoteLink(opts: RemoteLinkOptions): RemoteLink {
  const code = normalizeRoomCode(opts.code)
  if (!code) throw new Error(`invalid room code: ${opts.code}`)
  return new RelayLink(code, opts)
}

class RelayLink implements RemoteLink {
  readonly code: string
  readonly role: LinkRole
  private _peerId: string
  private readonly relayUrl: string
  private readonly WS: WebSocketCtor
  private readonly RTC: RTCPeerConnectionCtor | null
  private readonly p2pTimeout: number
  private readonly heartbeatMs: number

  private ws: WebSocket | null = null
  private wsOpen = false
  private closed = false
  private fatal = false
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private awaitingPong = false
  private counterparts = new Map<string, Counterpart>()
  private _status: LinkStatus = 'idle'
  private messages = createEmitter<LinkMessage>()
  private statuses = createEmitter<LinkStatus>()
  private lastStateSent = 0
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private pendingState: LinkMessage | null = null
  private detach: Array<() => void> = []

  constructor(code: string, private opts: RemoteLinkOptions) {
    this.code = code
    this.role = opts.role
    this._peerId = opts.peerId ?? defaultPeerId(opts.role)
    this.relayUrl = (opts.relayUrl ?? RELAY_URL).replace(/\/$/, '')
    this.WS = opts.WebSocket ?? globalThis.WebSocket
    this.RTC =
      opts.RTCPeerConnection === undefined
        ? ((globalThis as { RTCPeerConnection?: RTCPeerConnectionCtor }).RTCPeerConnection ?? null)
        : opts.RTCPeerConnection
    this.p2pTimeout = opts.p2pTimeoutMs ?? P2P_TIMEOUT_MS
    this.heartbeatMs = opts.heartbeatMs ?? 20_000
    this.listen()
    this.connect()
  }

  /* ───────────── Link API ───────────── */

  get status() {
    return this._status
  }

  get peerId() {
    return this._peerId
  }

  onMessage = (cb: (msg: LinkMessage) => void) => this.messages.on(cb)
  onStatus = (cb: (s: LinkStatus) => void) => this.statuses.on(cb)

  peers() {
    return [...this.counterparts.values()]
      .filter((cp) => cp.present || cp.channel?.open)
      .map((cp) => ({
        id: cp.id,
        role: cp.role,
        via: cp.channel?.open ? ('p2p' as const) : cp.mode === 'pending' ? ('connecting' as const) : ('relay' as const),
      }))
  }

  send(msg: LinkMessage) {
    if (this.closed) return
    // Coalesce state snapshots on the relay path so a 60 fps host stays under
    // the relay's per-socket rate limit. Data channels get every snapshot.
    if (msg.t === 'state' && this.role === 'host') {
      this.sendP2P(msg)
      if (!this.needsRelay()) return
      const wait = this.lastStateSent + STATE_MIN_GAP_MS - Date.now()
      if (wait > 0) {
        this.pendingState = msg
        this.stateTimer ??= setTimeout(() => {
          this.stateTimer = null
          const latest = this.pendingState
          this.pendingState = null
          if (latest) this.sendRelayState(latest)
        }, wait)
        return
      }
      this.sendRelayState(msg)
      return
    }
    if (this.role === 'host') {
      this.sendP2P(msg)
      if (this.needsRelay()) this.sendRelay(msg)
    } else {
      const host = this.host()
      if (!host) return
      if (!this.trySendChannel(host, msg)) this.sendRelay(msg, host.id)
    }
  }

  reconnect() {
    if (this.closed) return
    this.fatal = false
    this.backoff = 0
    this.dropSocket()
    this.connect()
  }

  close() {
    if (this.closed) return
    this.send({ t: 'bye' })
    this.closed = true
    for (const cp of this.counterparts.values()) this.disposeCounterpart(cp)
    this.counterparts.clear()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stopHeartbeat()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(1000, 'bye')
      } catch {}
    }
    this.wsOpen = false
    for (const off of this.detach) off()
    this.setStatus('closed')
    this.messages.clear()
    this.statuses.clear()
  }

  /* ───────────── WebSocket lifecycle ───────────── */

  private connect() {
    if (this.closed || this.ws) return
    const url = `${this.relayUrl}/room/${this.code}?role=${this.role}&id=${encodeURIComponent(this._peerId)}`
    let ws: WebSocket
    try {
      ws = new this.WS(url)
    } catch (err) {
      console.warn('[link] relay connect failed', err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.recompute()
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.wsOpen = true
      this.backoff = 0
      this.fatal = false
      this.startHeartbeat()
      this.recompute()
    }
    ws.onmessage = (e) => {
      if (this.ws === ws && typeof e.data === 'string') this.onFrame(e.data)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = null
      this.wsOpen = false
      this.stopHeartbeat()
      this.onSocketClosed(e.code)
    }
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    }
  }

  private onSocketClosed(code: number) {
    if (this.closed) return
    switch (code) {
      case RelayClose.REPLACED:
        // Another tab claimed our id (a duplicated tab copies sessionStorage).
        this._peerId = randomPeerId()
        try {
          sessionStorage.setItem(storageKey(this.role), this._peerId)
        } catch {}
        this.backoff = 0
        this.scheduleReconnect(0)
        break
      case RelayClose.BAD_REQUEST:
        this.fatal = true
        break
      case RelayClose.ROOM_FULL:
        this.fatal = true
        this.scheduleReconnect(10_000)
        break
      default:
        this.scheduleReconnect()
    }
    this.recompute()
  }

  private scheduleReconnect(delay?: number) {
    if (this.closed || this.reconnectTimer) return
    const base = delay ?? BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)]!
    this.backoff++
    const jitter = delay === 0 ? 0 : Math.random() * 0.3 * base
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, base + jitter)
  }

  private dropSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = null
    this.wsOpen = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(1000, 'reconnect')
      } catch {}
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.awaitingPong = false
    this.heartbeat = setInterval(() => this.ping(), this.heartbeatMs)
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** Sends a ping; if the previous one went unanswered the socket is dead. */
  private ping() {
    if (!this.wsOpen || !this.ws) return
    if (this.awaitingPong) {
      this.dropSocket()
      this.recompute()
      this.connect()
      return
    }
    this.awaitingPong = true
    try {
      this.ws.send(PING)
    } catch {}
  }

  private listen() {
    if (typeof window === 'undefined' && !this.opts.events) return
    const doc = this.opts.events?.document ?? (typeof document !== 'undefined' ? document : undefined)
    const win = this.opts.events?.window ?? (typeof window !== 'undefined' ? window : undefined)
    const onVisible = () => {
      if (doc?.visibilityState !== 'visible') return
      this.wake()
    }
    const onOnline = () => this.wake()
    doc?.addEventListener('visibilitychange', onVisible)
    win?.addEventListener('online', onOnline)
    this.detach.push(() => doc?.removeEventListener('visibilitychange', onVisible))
    this.detach.push(() => win?.removeEventListener('online', onOnline))
  }

  /** Phone woke up or network returned: verify everything quickly. */
  private wake() {
    if (this.closed) return
    if (!this.ws) {
      this.backoff = 0
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.connect()
    } else if (this.wsOpen) {
      // Two quick pings: if the first is not answered by the second, reconnect.
      this.awaitingPong = false
      this.ping()
      setTimeout(() => this.ping(), 4000)
    }
    if (this.role !== 'host') {
      const host = this.host()
      if (host && !host.channel && host.present) {
        host.attempts = 0
        this.offer(host)
      }
    }
  }

  /* ───────────── Relay frames ───────────── */

  private onFrame(text: string) {
    this.awaitingPong = false
    let f: Record<string, unknown>
    try {
      f = JSON.parse(text)
    } catch {
      return
    }
    if (typeof f !== 'object' || f === null) return
    switch (f.t) {
      case 'pong':
        return
      case 'err':
        console.warn('[link] relay refused a frame:', f.code)
        return
      case 'peers':
        return this.onPeers(f)
      case 'peer':
        return this.onPeerEvent(f)
      case 'sig':
        return this.onSig(f)
      default:
        return this.onRelayedPayload(f)
    }
  }

  private isCounterpartRole(role: LinkRole) {
    return this.role === 'host' ? role !== 'host' : role === 'host'
  }

  private onPeers(f: Record<string, unknown>) {
    if (typeof f.self === 'string') this._peerId = f.self
    const list = Array.isArray(f.list) ? f.list : []
    const seen = new Set<string>()
    for (const p of list as Array<Record<string, unknown>>) {
      if (typeof p?.id !== 'string' || !isLinkRole(p.role) || !this.isCounterpartRole(p.role)) continue
      seen.add(p.id)
      this.join(p.id, p.role)
    }
    for (const cp of [...this.counterparts.values()]) {
      if (!seen.has(cp.id)) this.leave(cp.id)
    }
    this.recompute()
  }

  private onPeerEvent(f: Record<string, unknown>) {
    if (typeof f.id !== 'string' || !isLinkRole(f.role) || !this.isCounterpartRole(f.role)) return
    if (f.event === 'join') this.join(f.id, f.role)
    else if (f.event === 'leave') this.leave(f.id)
    this.recompute()
  }

  private join(id: string, role: LinkRole) {
    if (this.role !== 'host') {
      // A guest follows exactly one host; a different host id replaces it.
      for (const cp of [...this.counterparts.values()]) if (cp.id !== id) this.removeCounterpart(cp)
    }
    let cp = this.counterparts.get(id)
    if (cp) {
      cp.present = true
      if (cp.channel?.open) return // relay blip; the data channel survived
      cp.greeted = false
      cp.attempts = 0
    } else {
      cp = {
        id,
        role,
        mode: 'pending',
        present: true,
        channel: null,
        session: null,
        timer: null,
        retry: null,
        attempts: 0,
        greeted: false,
        inbox: new Reassembler(),
      }
      this.counterparts.set(id, cp)
    }
    if (this.role === 'host') {
      if (!this.RTC) return this.settle(cp, 'relay')
      // Wait for the guest's offer; fall back if none arrives in time.
      if (cp.mode !== 'relay') this.armTimeout(cp, null)
    } else {
      this.offer(cp)
    }
  }

  private leave(id: string) {
    const cp = this.counterparts.get(id)
    if (!cp) return
    cp.present = false
    // Their WebSocket dropped but the data channel may still be alive.
    if (!cp.channel?.open) this.removeCounterpart(cp)
  }

  private removeCounterpart(cp: Counterpart) {
    this.disposeCounterpart(cp)
    this.counterparts.delete(cp.id)
  }

  private disposeCounterpart(cp: Counterpart) {
    if (cp.timer) clearTimeout(cp.timer)
    if (cp.retry) clearTimeout(cp.retry)
    cp.timer = cp.retry = null
    const ch = cp.channel
    cp.channel = null
    ch?.close()
  }

  private host(): Counterpart | undefined {
    for (const cp of this.counterparts.values()) if (cp.role === 'host') return cp
    return undefined
  }

  /* ───────────── WebRTC ───────────── */

  /** Guest: start (or restart) a data channel attempt to the host. */
  private offer(cp: Counterpart) {
    if (cp.retry) clearTimeout(cp.retry)
    cp.retry = null
    if (!this.RTC) return this.settle(cp, 'relay')
    if (cp.channel?.open) return
    cp.attempts++
    const session = randomPeerId().slice(0, 8)
    const channel = this.newChannel(cp, true, session)
    void channel.start()
  }

  private newChannel(cp: Counterpart, initiator: boolean, session: string): PeerChannel {
    const old = cp.channel
    cp.channel = null
    old?.close()
    if (cp.mode === 'p2p') cp.mode = 'relay'
    const channel: PeerChannel = new PeerChannel({
      initiator,
      RTC: this.RTC!,
      onSignal: (d) => this.sendSig(cp.id, session, d),
      onOpen: () => this.onChannelOpen(cp, channel),
      onClose: () => this.onChannelClose(cp, channel),
      onMessage: (text) => this.onChannelData(cp, text),
    })
    cp.channel = channel
    cp.session = session
    this.armTimeout(cp, channel)
    this.recompute()
    return channel
  }

  private armTimeout(cp: Counterpart, channel: PeerChannel | null) {
    if (cp.timer) clearTimeout(cp.timer)
    cp.timer = setTimeout(() => {
      cp.timer = null
      if (cp.channel !== channel || channel?.open) return
      if (channel) {
        cp.channel = null
        channel.close()
      }
      this.settle(cp, 'relay')
    }, this.p2pTimeout)
  }

  private onSig(f: Record<string, unknown>) {
    if (f.to !== this._peerId || typeof f.from !== 'string' || typeof f.s !== 'string') return
    const d = parseSignal(f.d)
    const cp = this.counterparts.get(f.from)
    if (!d || !cp || !this.RTC) return
    if (this.role === 'host') {
      if ('type' in d && d.type === 'offer') {
        if (cp.session !== f.s || !cp.channel) this.newChannel(cp, false, f.s)
      } else if (cp.session !== f.s) {
        return
      }
    } else if (cp.session !== f.s) {
      return
    }
    void cp.channel?.handleSignal(d)
  }

  private sendSig(to: string, session: string, d: SignalData) {
    this.sendRaw(JSON.stringify({ t: 'sig', to, from: this._peerId, s: session, d }))
  }

  private onChannelOpen(cp: Counterpart, channel: PeerChannel) {
    if (cp.channel !== channel) return
    if (cp.timer) clearTimeout(cp.timer)
    cp.timer = null
    cp.attempts = 0
    this.settle(cp, 'p2p')
  }

  private onChannelClose(cp: Counterpart, channel: PeerChannel) {
    if (cp.channel !== channel) return
    cp.channel = null
    if (this.closed) return
    if (!cp.present) {
      this.removeCounterpart(cp)
      this.recompute()
      return
    }
    if (cp.mode === 'p2p') this.settle(cp, 'relay')
    // Guests keep trying to get back to a direct connection.
    if (this.role !== 'host' && cp.attempts < MAX_P2P_RETRIES && !cp.retry) {
      cp.retry = setTimeout(() => {
        cp.retry = null
        if (this.counterparts.get(cp.id) === cp && cp.present) this.offer(cp)
      }, 1500 * Math.max(1, cp.attempts))
    }
    this.recompute()
  }

  private settle(cp: Counterpart, mode: Exclude<Mode, 'pending'>) {
    cp.mode = mode
    this.recompute()
    // Greet once the transport is decided, so the host's reply (state, script)
    // takes the data channel whenever one is possible.
    if (this.role !== 'host' && !cp.greeted) {
      cp.greeted = true
      const name = this.opts.name
      this.send(name ? { t: 'hello', role: this.role, name } : { t: 'hello', role: this.role })
    }
  }

  /* ───────────── Payload in/out ───────────── */

  private onChannelData(cp: Counterpart, text: string) {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const msg = cp.inbox.accept(frame, cp.id)
    if (msg) this.messages.emit(msg)
  }

  private onRelayedPayload(f: Record<string, unknown>) {
    const from = typeof f.from === 'string' ? f.from : ''
    const cp = this.counterparts.get(from)
    if (!cp) return // guests ignore each other; strangers are ignored
    if (this.role !== 'host' && cp.channel?.open) return // p2p wins; relay copy is a duplicate
    const msg = cp.inbox.accept(f, cp.id)
    if (msg) this.messages.emit(msg)
  }

  private trySendChannel(cp: Counterpart, msg: LinkMessage): boolean {
    if (!cp.channel?.open) return false
    for (const frame of toFrames(msg)) if (!cp.channel.send(frame)) return false
    return true
  }

  private sendP2P(msg: LinkMessage) {
    for (const cp of this.counterparts.values()) this.trySendChannel(cp, msg)
  }

  /** Host: is any guest only reachable through the relay? */
  private needsRelay(): boolean {
    for (const cp of this.counterparts.values()) if (cp.present && !cp.channel?.open) return true
    return false
  }

  private sendRelayState(msg: LinkMessage) {
    this.lastStateSent = Date.now()
    this.sendRelay(msg)
  }

  private sendRelay(msg: LinkMessage, to?: string) {
    if (!this.wsOpen) return
    const extra: Record<string, string> = { from: this._peerId }
    if (to) extra.to = to
    for (const frame of toFrames(msg, extra)) this.sendRaw(frame)
  }

  private sendRaw(text: string) {
    if (!this.wsOpen || !this.ws) return
    try {
      this.ws.send(text)
    } catch {}
  }

  /* ───────────── Status ───────────── */

  private recompute() {
    if (this.closed) return this.setStatus('closed')
    const live = [...this.counterparts.values()].filter((cp) => cp.present || cp.channel?.open)
    const anyP2P = live.some((cp) => cp.channel?.open)
    let next: LinkStatus
    if (this.fatal && !anyP2P) next = 'error'
    else if (live.length === 0) next = this.wsOpen ? 'waiting' : 'connecting'
    else if (this.wsOpen && live.some((cp) => cp.mode === 'relay' && !cp.channel?.open)) next = 'relay'
    else if (anyP2P) next = 'p2p'
    else next = 'connecting'
    this.setStatus(next)
  }

  private setStatus(s: LinkStatus) {
    if (s === this._status) return
    this._status = s
    this.statuses.emit(s)
  }
}
