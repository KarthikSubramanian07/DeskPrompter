#!/usr/bin/env bun
/**
 * End-to-end check for the relay. Runs against `wrangler dev` by default:
 *
 *   bun crates/relay/e2e.ts                                  # http://127.0.0.1:8787
 *   bun crates/relay/e2e.ts https://deskprompter-relay.<you>.workers.dev
 *
 * Opens real WebSockets as host / remote / display and asserts relaying,
 * targeted signaling, join/leave frames, validation, heartbeat, capacity and
 * reconnect replacement.
 */

const base = (process.argv[2] ?? process.env.RELAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const wsBase = base.replace(/^http/, 'ws')
const ORIGIN = 'http://localhost:5173'
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('')

type Frame = Record<string, unknown> & { t: string }

class Peer {
  ws: WebSocket
  frames: Frame[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: Array<() => void> = []

  constructor(role: string, id: string, origin = ORIGIN, room = code) {
    // Bun extends the WebSocket constructor with a headers option.
    this.ws = new WebSocket(`${wsBase}/room/${room}?role=${role}&id=${id}`, { headers: { Origin: origin } } as never)
    this.ws.onmessage = (e) => {
      this.frames.push(JSON.parse(String(e.data)))
      this.flush()
    }
    this.ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason }
      this.flush()
    }
  }

  private flush() {
    const w = this.waiters
    this.waiters = []
    w.forEach((f) => f())
  }

  async next(pred: (f: Frame) => boolean, label: string, ms = 5000): Promise<Frame> {
    const deadline = Date.now() + ms
    for (;;) {
      const i = this.frames.findIndex(pred)
      if (i >= 0) return this.frames.splice(i, 1)[0]!
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${label}; have ${JSON.stringify(this.frames)}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, left)
      })
    }
  }

  async waitClosed(label: string, ms = 5000) {
    const deadline = Date.now() + ms
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    if (!this.closed) throw new Error(`timed out waiting for close: ${label}`)
    return this.closed
  }

  send(obj: unknown) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj))
  }

  async quiet(ms = 400) {
    await new Promise((r) => setTimeout(r, ms))
    return this.frames.splice(0)
  }
}

let passed = 0
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}

console.log(`relay e2e against ${base} (room ${code})`)

// HTTP surface
const health = await fetch(`${base}/health`)
const body = (await health.json()) as { ok: boolean; service: string }
ok(health.status === 200 && body.ok && body.service === 'deskprompter-relay', '/health reports ok')
ok((await fetch(`${base}/room/BAD0OI?role=host`)).status === 400, 'invalid room code is rejected (400)')
ok((await fetch(`${base}/room/${code}?role=host`, { headers: { Origin: ORIGIN } })).status === 426, 'non-upgrade request gets 426')
{
  const evil = new Peer('host', 'evil-e2e', 'https://evil.example')
  let opened = false
  evil.ws.onopen = () => (opened = true)
  await evil.waitClosed('foreign origin')
  ok(!opened, 'WebSocket from a foreign origin is refused')
}

// Join + peers list
const host = new Peer('host', 'host-e2e')
const hp = await host.next((f) => f.t === 'peers', 'host peers')
ok(hp.self === 'host-e2e' && Array.isArray(hp.list) && hp.list.length === 0, 'host joins an empty room')

const remote = new Peer('remote', 'remote-e2e')
const rp = await remote.next((f) => f.t === 'peers', 'remote peers')
ok(JSON.stringify(rp.list) === JSON.stringify([{ id: 'host-e2e', role: 'host' }]), 'remote sees the host in its peers list')
const join = await host.next((f) => f.t === 'peer', 'join')
ok(join.event === 'join' && join.role === 'remote' && join.id === 'remote-e2e', 'host gets a join frame for the remote')

// Relay both ways
remote.send({ t: 'cmd', c: 'toggle' })
const cmd = await host.next((f) => f.t === 'cmd', 'cmd')
ok(cmd.c === 'toggle', 'remote → host command is relayed verbatim')
const snapshot = { t: 'state', s: { playing: true, speed: 4, progress: 0.25, title: 'Pilot' } }
host.send(snapshot)
const st = await remote.next((f) => f.t === 'state', 'state')
ok(JSON.stringify(st) === JSON.stringify(snapshot), 'host → remote state is relayed verbatim')

// Targeted signaling
const display = new Peer('display', 'display-e2e')
await display.next((f) => f.t === 'peers', 'display peers')
await host.next((f) => f.t === 'peer' && f.id === 'display-e2e', 'display join (host)')
await remote.next((f) => f.t === 'peer' && f.id === 'display-e2e', 'display join (remote)')
host.send({ t: 'sig', to: 'remote-e2e', from: 'host-e2e', sdp: { type: 'offer', sdp: 'v=0' } })
const sig = await remote.next((f) => f.t === 'sig', 'sig')
ok(sig.from === 'host-e2e', 'frame with "to" reaches its target')
ok((await display.quiet()).every((f) => f.t !== 'sig'), 'frame with "to" does not reach other peers')

// Validation
remote.send('not json')
ok((await remote.next((f) => f.t === 'err', 'err invalid')).code === 'invalid', 'non-JSON frame gets err:invalid')
remote.send({ t: 'peer', event: 'join', id: 'spoof', role: 'host' })
ok((await remote.next((f) => f.t === 'err', 'err reserved')).code === 'invalid', 'spoofed control frame is refused')
remote.send({ t: 'script', text: 'x'.repeat(17 * 1024) })
ok((await remote.next((f) => f.t === 'err', 'err too_big')).code === 'too_big', 'frame over 16 KB gets err:too_big')
ok((await host.quiet()).every((f) => f.t !== 'script' && f.t !== 'peer'), 'refused frames are not relayed')

// Heartbeat (answered by the runtime without waking the room)
remote.send('{"t":"ping"}')
ok((await remote.next((f) => f.t === 'pong', 'pong')).t === 'pong', 'ping is answered with pong')

// Rate limit
for (let i = 0; i < 150; i++) remote.send({ t: 'cmd', c: 'nudge', v: i })
const rate = await remote.next((f) => f.t === 'err' && f.code === 'rate', 'err rate')
ok(rate.code === 'rate', 'a burst over 60 msgs is rate limited')
await new Promise((r) => setTimeout(r, 300))
const relayed = host.frames.filter((f) => f.t === 'cmd').length
ok(relayed >= 55 && relayed < 150, `only the allowed burst is relayed (${relayed}/150)`)
host.frames.length = 0
await new Promise((r) => setTimeout(r, 1100))

// Reconnect with the same id replaces the stale socket without a leave frame
const remote2 = new Peer('remote', 'remote-e2e')
await remote2.next((f) => f.t === 'peers', 'remote2 peers')
const replaced = await remote.waitClosed('replaced remote')
ok(replaced.code === 4000, 'reconnecting with the same id closes the stale socket (4000)')
const rejoin = await host.next((f) => f.t === 'peer', 'rejoin')
ok(rejoin.event === 'join' && rejoin.id === 'remote-e2e', 'host sees a join (not a leave) on reconnect')
remote2.send({ t: 'cmd', c: 'faster' })
ok((await host.next((f) => f.t === 'cmd', 'cmd after reconnect')).c === 'faster', 'reconnected remote can still control the host')

// Capacity: 1 host + 6 guests
const extra: Peer[] = []
for (let i = 0; i < 4; i++) {
  const p = new Peer('remote', `extra-${i}`)
  await p.next((f) => f.t === 'peers', `extra ${i}`)
  extra.push(p)
}
const overflow = new Peer('display', 'overflow')
const full = await overflow.waitClosed('overflow')
ok(full.code === 4409, 'the seventh guest is turned away with 4409 room full')

// Leave
host.frames.length = 0
remote2.ws.close(1000, 'done')
const leave = await host.next((f) => f.t === 'peer' && f.event === 'leave', 'leave')
ok(leave.id === 'remote-e2e' && leave.role === 'remote', 'host gets a leave frame when a remote disconnects')

for (const p of [host, display, ...extra]) p.ws.close()
console.log(`\nall ${passed} checks passed`)
process.exit(0)
