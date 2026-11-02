/**
 * Test doubles for the link layer: an in-memory relay that mimics
 * crates/relay (peers/peer frames, `to` routing, replacement, capacity), and a
 * fake RTCPeerConnection network whose data channels can be blocked or cut.
 */

type Handler<E> = ((ev: E) => void) | null

const tick = () => Promise.resolve()

/* ───────────────────────── Relay + WebSocket ───────────────────────── */

interface Member {
  ws: FakeWebSocket
  id: string
  role: string
}

export class FakeRelay {
  rooms = new Map<string, Member[]>()
  /** Every client→relay text frame, for asserting what the server could see. */
  log: Array<{ room: string; from: string; text: string }> = []
  maxGuests = 6
  /** Refuse new connections (simulates the relay being unreachable). */
  down = false

  readonly WebSocket: new (url: string) => FakeWebSocket

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const relay = this
    this.WebSocket = class extends FakeWebSocket {
      constructor(url: string) {
        super(url, relay)
      }
    }
  }

  members(room: string) {
    return this.rooms.get(room) ?? []
  }

  /** Payload frames (anything but signaling and heartbeat) the relay carried. */
  payloadFrames(room?: string) {
    return this.log.filter((l) => (!room || l.room === room) && !/^\{"t":"(sig|ping)"/.test(l.text))
  }

  open(ws: FakeWebSocket) {
    if (this.down) return ws.serverClose(1006, '')
    const url = new URL(ws.url)
    const room = url.pathname.split('/').pop()!
    const role = url.searchParams.get('role')!
    const id = url.searchParams.get('id')!
    const members = this.members(room)
    const stale = members.filter((m) => m.id === id || (role === 'host' && m.role === 'host'))
    const guests = members.filter((m) => m.role !== 'host' && !stale.includes(m)).length
    if (role !== 'host' && guests >= this.maxGuests) {
      ws.readyState = 1
      ws.onopen?.(new Event('open'))
      return ws.serverClose(4409, 'room full')
    }
    let list = members.filter((m) => !stale.includes(m))
    for (const s of stale) {
      s.ws.serverClose(4000, 'replaced')
      if (s.id !== id) for (const m of list) m.ws.deliver(JSON.stringify({ t: 'peer', event: 'leave', role: s.role, id: s.id }))
    }
    ws.room = room
    ws.peerId = id
    ws.readyState = 1
    ws.onopen?.(new Event('open'))
    ws.deliver(JSON.stringify({ t: 'peers', self: id, role, list: list.map((m) => ({ id: m.id, role: m.role })) }))
    for (const m of list) m.ws.deliver(JSON.stringify({ t: 'peer', event: 'join', role, id }))
    list = [...list, { ws, id, role }]
    this.rooms.set(room, list)
  }

  message(ws: FakeWebSocket, text: string) {
    const room = ws.room!
    this.log.push({ room, from: ws.peerId!, text })
    if (text.length > 16 * 1024) return ws.deliver('{"t":"err","code":"too_big"}')
    let f: { t?: unknown; to?: unknown }
    try {
      f = JSON.parse(text)
    } catch {
      return ws.deliver('{"t":"err","code":"invalid"}')
    }
    if (f.t === 'ping') return ws.deliver('{"t":"pong"}')
    for (const m of this.members(room)) {
      if (m.ws === ws || (typeof f.to === 'string' && f.to !== m.id)) continue
      m.ws.deliver(text)
    }
  }

  leave(ws: FakeWebSocket) {
    const room = ws.room
    if (!room) return
    const members = this.members(room)
    const me = members.find((m) => m.ws === ws)
    if (!me) return
    const rest = members.filter((m) => m !== me)
    this.rooms.set(room, rest)
    for (const m of rest) m.ws.deliver(JSON.stringify({ t: 'peer', event: 'leave', role: me.role, id: me.id }))
  }

  /** Simulates a network drop for one client (no close handshake). */
  drop(peerId: string) {
    for (const members of this.rooms.values()) {
      const m = members.find((x) => x.id === peerId)
      if (m) m.ws.serverClose(1006, '')
    }
  }
}

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  room?: string
  peerId?: string
  onopen: Handler<Event> = null
  onmessage: Handler<MessageEvent> = null
  onclose: Handler<CloseEvent> = null
  onerror: Handler<Event> = null

  constructor(
    public url: string,
    private relay: FakeRelay,
  ) {
    void tick().then(() => this.relay.open(this))
  }

  send(text: string) {
    if (this.readyState !== 1) throw new Error('not open')
    this.relay.message(this, text)
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.relay.leave(this)
    void tick().then(() => this.onclose?.({ code, reason, wasClean: true } as CloseEvent))
  }

  deliver(text: string) {
    void tick().then(() => {
      if (this.readyState === 1) this.onmessage?.({ data: text } as MessageEvent)
    })
  }

  serverClose(code: number, reason: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay.leave(this)
    void tick().then(() => this.onclose?.({ code, reason, wasClean: code !== 1006 } as CloseEvent))
  }
}

/* ───────────────────────── WebRTC ───────────────────────── */

export class FakeRTCNetwork {
  /** When true, data channels never open (symmetric NAT, blocked UDP, ...). */
  blocked = false
  pcs = new Map<string, FakePeerConnection>()
  private n = 0
  readonly RTCPeerConnection: new (config?: RTCConfiguration) => RTCPeerConnection
  configs: Array<RTCConfiguration | undefined> = []

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const net = this
    this.RTCPeerConnection = class extends FakePeerConnection {
      constructor(config?: RTCConfiguration) {
        super(net, `pc${net.n++}`)
        net.configs.push(config)
      }
    } as unknown as new (config?: RTCConfiguration) => RTCPeerConnection
  }

  openChannels() {
    return [...this.pcs.values()].filter((pc) => pc.dc?.readyState === 'open')
  }

  /** Cuts every open data channel, as when a phone switches networks. */
  cutAll() {
    for (const pc of this.pcs.values()) pc.dc?.remoteClose()
  }
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  onopen: Handler<Event> = null
  onclose: Handler<Event> = null
  onmessage: Handler<MessageEvent> = null
  peer: FakeDataChannel | null = null
  sent: string[] = []

  send(text: string) {
    if (this.readyState !== 'open') throw new Error('dc not open')
    this.sent.push(text)
    const peer = this.peer
    void tick().then(() => {
      if (peer?.readyState === 'open') peer.onmessage?.({ data: text } as MessageEvent)
    })
  }

  open() {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }

  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.(new Event('close'))
    const peer = this.peer
    void tick().then(() => peer?.remoteClose())
  }

  remoteClose() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.(new Event('close'))
  }
}

export class FakePeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  onicecandidate: Handler<RTCPeerConnectionIceEvent> = null
  onconnectionstatechange: Handler<Event> = null
  dc: FakeDataChannel | null = null
  closed = false
  candidates: RTCIceCandidateInit[] = []

  constructor(
    private net: FakeRTCNetwork,
    public uid: string,
  ) {
    net.pcs.set(uid, this)
  }

  createDataChannel(_label: string, init?: RTCDataChannelInit) {
    if (!init?.negotiated || init.id !== 0) throw new Error('expected a negotiated channel with id 0')
    this.dc = new FakeDataChannel()
    return this.dc
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: `fake-${this.uid}` }
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: `fake-${this.uid}` }
  }

  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d
    // Trickle one candidate, then end-of-candidates.
    void tick().then(() => {
      if (this.closed) return
      const c = { candidate: `candidate:${this.uid} 1 udp 1 127.0.0.1 9 typ host`, sdpMid: '0', sdpMLineIndex: 0 }
      this.onicecandidate?.({ candidate: { toJSON: () => c } } as unknown as RTCPeerConnectionIceEvent)
      this.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent)
    })
    this.maybeConnect()
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d
    this.maybeConnect()
  }

  async addIceCandidate(c: RTCIceCandidateInit) {
    if (!this.remoteDescription) throw new Error('remote description not set')
    this.candidates.push(c)
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
    this.dc?.close()
  }

  private maybeConnect() {
    if (!this.localDescription || !this.remoteDescription) return
    const other = this.net.pcs.get(String(this.remoteDescription.sdp).replace(/^fake-/, ''))
    if (!other || other.closed || !other.localDescription || !other.remoteDescription) return
    if (other.remoteDescription.sdp !== this.localDescription.sdp) return
    if (this.net.blocked) return
    const a = this.dc!
    const b = other.dc!
    a.peer = b
    b.peer = a
    setTimeout(() => {
      if (this.closed || other.closed) return
      this.connectionState = other.connectionState = 'connected'
      a.open()
      b.open()
    }, 5)
  }
}

/* ───────────────────────── BroadcastChannel ───────────────────────── */

export class FakeBroadcastHub {
  private channels = new Set<FakeBroadcastChannel>()

  create = (name: string) => {
    const ch = new FakeBroadcastChannel(name, this)
    this.channels.add(ch)
    return ch
  }

  post(from: FakeBroadcastChannel, data: unknown) {
    // Structured clone, like the real thing.
    const copy = structuredClone(data)
    for (const ch of this.channels) {
      if (ch !== from && ch.name === from.name) void tick().then(() => ch.onmessage?.({ data: copy } as MessageEvent))
    }
  }

  remove(ch: FakeBroadcastChannel) {
    this.channels.delete(ch)
  }
}

export class FakeBroadcastChannel {
  onmessage: ((ev: MessageEvent) => void) | null = null
  constructor(
    public name: string,
    private hub: FakeBroadcastHub,
  ) {}
  postMessage(data: unknown) {
    this.hub.post(this, data)
  }
  close() {
    this.hub.remove(this)
  }
}

/* ───────────────────────── helpers ───────────────────────── */

export async function waitFor(cond: () => boolean, label = 'condition', ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
