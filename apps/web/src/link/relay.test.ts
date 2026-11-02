import { afterEach, describe, expect, it } from 'vitest'
import type { LinkMessage, LinkStatus, PrompterSnapshot } from '../core/contracts'
import { createRemoteLink, type RemoteLink, type RemoteLinkOptions } from './relay'
import { FakeRTCNetwork, FakeRelay, waitFor } from './testing/fakes'

const CODE = 'K7PQ2M'

const snap: PrompterSnapshot = {
  playing: false,
  speed: 3,
  progress: 0.1,
  elapsedMs: 1000,
  remainingMs: 9000,
  wpm: 140,
  mode: 'manual',
  mirrorX: false,
  mirrorY: false,
  title: 'Pilot',
  currentLine: 'Good evening.',
}

let links: RemoteLink[] = []
afterEach(() => {
  for (const l of links) l.close()
  links = []
})

function setup(opts: { rtc?: boolean } = {}) {
  const relay = new FakeRelay()
  const net = new FakeRTCNetwork()
  const make = (role: RemoteLinkOptions['role'], peerId: string, extra: Partial<RemoteLinkOptions> = {}) => {
    const link = createRemoteLink({
      code: CODE,
      role,
      peerId,
      relayUrl: 'wss://relay.test',
      WebSocket: relay.WebSocket as unknown as RemoteLinkOptions['WebSocket'],
      RTCPeerConnection: opts.rtc === false ? null : net.RTCPeerConnection,
      p2pTimeoutMs: 80,
      heartbeatMs: 60_000,
      ...extra,
    })
    links.push(link)
    const inbox: LinkMessage[] = []
    const statuses: LinkStatus[] = [link.status]
    link.onMessage((m) => inbox.push(m))
    link.onStatus((s) => statuses.push(s))
    return { link, inbox, statuses }
  }
  return { relay, net, make }
}

describe('createRemoteLink', () => {
  it('rejects invalid room codes up front', () => {
    expect(() => createRemoteLink({ code: 'NOPE', role: 'remote' })).toThrow(/invalid room code/)
  })

  it('waits for a host, then goes peer-to-peer and keeps payloads off the relay', async () => {
    const { relay, net, make } = setup()
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'waiting', 'remote waiting')
    const host = make('host', 'host00001')
    await waitFor(() => remote.link.status === 'p2p' && host.link.status === 'p2p', 'p2p both ends')

    expect(net.configs[0]?.iceServers?.[0]?.urls).toEqual(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'])
    // The remote greets once the transport settles.
    await waitFor(() => host.inbox.some((m) => m.t === 'hello'), 'hello')
    expect(host.inbox[0]).toEqual({ t: 'hello', role: 'remote' })

    remote.link.send({ t: 'cmd', c: 'toggle' })
    host.link.send({ t: 'state', s: snap })
    host.link.send({ t: 'script', title: 'Secret', text: 'Only for your eyes. '.repeat(3000) })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd'), 'cmd over p2p')
    await waitFor(() => remote.inbox.some((m) => m.t === 'script'), 'script over p2p')
    expect(remote.inbox.find((m) => m.t === 'state')).toEqual({ t: 'state', s: snap })
    expect(remote.link.peers()).toEqual([{ id: 'host00001', role: 'host', via: 'p2p' }])

    // The relay carried only signaling: no commands, state or script text.
    expect(relay.payloadFrames()).toEqual([])
    expect(relay.log.some((l) => l.text.includes('Only for your eyes'))).toBe(false)
    expect(relay.log.some((l) => l.text.startsWith('{"t":"sig"'))).toBe(true)
  })

  it('falls back to the relay when WebRTC cannot connect', async () => {
    const { relay, net, make } = setup()
    net.blocked = true
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'relay' && host.link.status === 'relay', 'relay both ends')
    expect(remote.statuses).toContain('connecting')
    expect(remote.statuses).not.toContain('p2p')

    await waitFor(() => host.inbox.some((m) => m.t === 'hello'), 'hello via relay')
    remote.link.send({ t: 'cmd', c: 'faster' })
    host.link.send({ t: 'state', s: snap })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd'), 'cmd via relay')
    await waitFor(() => remote.inbox.some((m) => m.t === 'state'), 'state via relay')
    expect(relay.payloadFrames().some((f) => f.text.includes('"c":"faster"'))).toBe(true)
    // Commands are addressed to the host, not broadcast.
    const cmd = relay.payloadFrames().find((f) => f.text.includes('"c":"faster"'))!
    expect(JSON.parse(cmd.text)).toMatchObject({ from: 'remote001', to: 'host00001' })
  })

  it('uses the relay straight away when WebRTC is unavailable', async () => {
    const { make } = setup({ rtc: false })
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'relay', 'relay')
    expect(remote.statuses).not.toContain('p2p')
    remote.link.send({ t: 'cmd', c: 'play' })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd'), 'cmd')
  })

  it('drops to the relay when the data channel dies, then recovers p2p', async () => {
    const { net, make } = setup()
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'p2p', 'p2p')

    net.cutAll()
    await waitFor(() => remote.link.status === 'relay', 'relay after cut')
    remote.link.send({ t: 'cmd', c: 'back' })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd' && m.c === 'back'), 'cmd during outage')

    // The guest retries in the background and returns to a direct channel.
    await waitFor(() => remote.link.status === 'p2p' && host.link.status === 'p2p', 'p2p again', 5000)
    remote.link.send({ t: 'cmd', c: 'forward' })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd' && m.c === 'forward'), 'cmd after recovery')
    expect(host.inbox.filter((m) => m.t === 'cmd' && m.c === 'back')).toHaveLength(1)
  })

  it('reconnects the WebSocket after a network drop', async () => {
    const { relay, make } = setup({ rtc: false })
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'relay', 'relay')
    relay.drop('remote001')
    await waitFor(() => remote.link.status === 'connecting', 'connecting after drop')
    await waitFor(() => host.link.status === 'waiting', 'host sees remote leave')
    await waitFor(() => remote.link.status === 'relay', 'back on relay', 4000)
    remote.link.send({ t: 'cmd', c: 'top' })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd' && m.c === 'top'), 'cmd after reconnect')
  })

  it('keeps a live data channel across a relay blip', async () => {
    const { relay, make } = setup()
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'p2p', 'p2p')
    relay.drop('remote001')
    await new Promise((r) => setTimeout(r, 20))
    expect(remote.link.status).toBe('p2p')
    remote.link.send({ t: 'cmd', c: 'pause' })
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd'), 'cmd while relay is down')
  })

  it('reconnects immediately when the page becomes visible again', async () => {
    const { relay, make } = setup({ rtc: false })
    relay.down = true
    const listeners = new Map<string, () => void>()
    const doc = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: (t: string, f: () => void) => listeners.set(t, f),
      removeEventListener: () => {},
    }
    const host = make('host', 'host00001')
    host.link.close()
    const remote = make('remote', 'remote001', { events: { document: doc as never, window: { addEventListener() {}, removeEventListener() {} } } })
    await new Promise((r) => setTimeout(r, 30))
    expect(remote.link.status).toBe('connecting')
    relay.down = false
    const h2 = make('host', 'host00001')
    doc.visibilityState = 'visible'
    listeners.get('visibilitychange')!()
    await waitFor(() => remote.link.status === 'relay', 'reconnected on wake', 400)
    expect(h2.link.status).toBe('relay')
  })

  it('tells the guest when the host leaves and greets the next host', async () => {
    const { make } = setup()
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'p2p', 'p2p')
    host.link.close()
    await waitFor(() => remote.link.status === 'waiting', 'waiting after host left')
    expect(remote.inbox.some((m) => m.t === 'bye')).toBe(true)
    const host2 = make('host', 'host00002')
    await waitFor(() => host2.inbox.some((m) => m.t === 'hello'), 'hello to new host')
    expect(remote.link.status).toBe('p2p')
  })

  it('serves several guests and keeps guests from hearing each other', async () => {
    const { net, make } = setup()
    net.blocked = true
    const host = make('host', 'host00001')
    const r1 = make('remote', 'remote001')
    const disp = make('display', 'display01')
    await waitFor(() => r1.link.status === 'relay' && disp.link.status === 'relay', 'guests on relay')
    r1.link.send({ t: 'cmd', c: 'mirror' })
    host.link.send({ t: 'state', s: snap })
    await waitFor(() => disp.inbox.some((m) => m.t === 'state') && r1.inbox.some((m) => m.t === 'state'), 'state to all')
    await waitFor(() => host.inbox.some((m) => m.t === 'cmd'), 'cmd to host')
    expect(disp.inbox.some((m) => m.t === 'cmd')).toBe(false)
    expect(host.link.peers().map((p) => p.id).sort()).toEqual(['display01', 'remote001'])
  })

  it('chunks a large script over the relay under the 16 KB frame cap', async () => {
    const { relay, net, make } = setup()
    net.blocked = true
    const host = make('host', 'host00001')
    const disp = make('display', 'display01')
    await waitFor(() => disp.link.status === 'relay', 'relay')
    const text = 'Τα φώτα της σκηνής χαμηλώνουν. [pause] Now the second act begins. '.repeat(2500)
    host.link.send({ t: 'script', title: 'Act II', text })
    await waitFor(() => disp.inbox.some((m) => m.t === 'script'), 'script', 5000)
    expect(disp.inbox.find((m) => m.t === 'script')).toEqual({ t: 'script', title: 'Act II', text })
    const chunks = relay.log.filter((l) => l.text.startsWith('{"t":"chunk"'))
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(new TextEncoder().encode(c.text).length).toBeLessThanOrEqual(16 * 1024)
  })

  it('coalesces rapid state snapshots on the relay path', async () => {
    const { relay, net, make } = setup()
    net.blocked = true
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => host.link.status === 'relay', 'relay')
    for (let i = 0; i < 100; i++) host.link.send({ t: 'state', s: { ...snap, progress: i / 100 } })
    await waitFor(() => remote.inbox.some((m) => m.t === 'state' && m.s.progress === 0.99), 'latest state')
    const sent = relay.log.filter((l) => l.text.startsWith('{"t":"state"'))
    expect(sent.length).toBeLessThanOrEqual(3)
  })

  it('reports error when the room is full', async () => {
    const { relay, make } = setup({ rtc: false })
    relay.maxGuests = 1
    make('host', 'host00001')
    const a = make('remote', 'remote001')
    await waitFor(() => a.link.status === 'relay', 'first guest')
    const b = make('remote', 'remote002')
    await waitFor(() => b.link.status === 'error', 'room full')
  })

  it('takes a fresh id when another tab claims the same one', async () => {
    const { make } = setup({ rtc: false })
    make('host', 'host00001')
    const a = make('remote', 'samesame01')
    await waitFor(() => a.link.status === 'relay', 'a on relay')
    const b = make('remote', 'samesame01')
    await waitFor(() => b.link.status === 'relay', 'b on relay')
    await waitFor(() => a.link.peerId !== 'samesame01' && a.link.status === 'relay', 'a re-ids and rejoins')
  })

  it('closes cleanly', async () => {
    const { make } = setup()
    const host = make('host', 'host00001')
    const remote = make('remote', 'remote001')
    await waitFor(() => remote.link.status === 'p2p', 'p2p')
    remote.link.close()
    expect(remote.link.status).toBe('closed')
    await waitFor(() => host.inbox.some((m) => m.t === 'bye'), 'bye')
    await waitFor(() => host.link.status === 'waiting', 'host waiting')
    remote.link.send({ t: 'cmd', c: 'play' })
    await new Promise((r) => setTimeout(r, 20))
    expect(host.inbox.some((m) => m.t === 'cmd')).toBe(false)
  })
})
