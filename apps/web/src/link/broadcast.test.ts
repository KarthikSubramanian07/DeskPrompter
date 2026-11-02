import { describe, expect, it } from 'vitest'
import type { LinkMessage } from '../core/contracts'
import { createLocalLink } from './broadcast'
import { FakeBroadcastHub, waitFor } from './testing/fakes'

describe('createLocalLink', () => {
  it('connects windows on the same channel with status local', async () => {
    const hub = new FakeBroadcastHub()
    const host = createLocalLink('host', 'deskprompter', { createChannel: hub.create })
    const got: LinkMessage[] = []
    host.onMessage((m) => got.push(m))
    const display = createLocalLink('display', 'deskprompter', { createChannel: hub.create, name: 'Mirror' })
    const toDisplay: LinkMessage[] = []
    display.onMessage((m) => toDisplay.push(m))

    expect(host.status).toBe('local')
    expect(display.status).toBe('local')
    await waitFor(() => got.length > 0, 'hello')
    expect(got[0]).toEqual({ t: 'hello', role: 'display', name: 'Mirror' })

    host.send({ t: 'script', title: 'Pilot', text: 'Hello there' })
    host.send({ t: 'cmd', c: 'mirror' })
    await waitFor(() => toDisplay.length === 2, 'script + cmd')
    expect(toDisplay).toEqual([
      { t: 'script', title: 'Pilot', text: 'Hello there' },
      { t: 'cmd', c: 'mirror' },
    ])
  })

  it('ignores other channels and malformed data', async () => {
    const hub = new FakeBroadcastHub()
    const a = createLocalLink('host', 'room-a', { createChannel: hub.create })
    const got: LinkMessage[] = []
    a.onMessage((m) => got.push(m))
    createLocalLink('remote', 'room-b', { createChannel: hub.create })
    const raw = hub.create('room-a')
    raw.postMessage({ t: 'cmd', c: 'self-destruct' })
    raw.postMessage('garbage')
    raw.postMessage({ t: 'cmd', c: 'play' })
    await waitFor(() => got.length === 1, 'valid cmd')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ t: 'cmd', c: 'play' }])
  })

  it('says bye and stops on close', async () => {
    const hub = new FakeBroadcastHub()
    const host = createLocalLink('host', 'x', { createChannel: hub.create })
    const got: LinkMessage[] = []
    host.onMessage((m) => got.push(m))
    const remote = createLocalLink('remote', 'x', { createChannel: hub.create })
    const statuses: string[] = []
    remote.onStatus((s) => statuses.push(s))
    remote.close()
    remote.send({ t: 'cmd', c: 'play' })
    await waitFor(() => got.some((m) => m.t === 'bye'), 'bye')
    expect(got.map((m) => m.t)).toEqual(['hello', 'bye'])
    expect(remote.status).toBe('closed')
    expect(statuses).toEqual(['closed'])
  })

  it.runIf(typeof BroadcastChannel !== 'undefined')('works with the real BroadcastChannel', async () => {
    const name = `t-${Math.random()}`
    const a = createLocalLink('host', name)
    const got: LinkMessage[] = []
    a.onMessage((m) => got.push(m))
    const b = createLocalLink('remote', name)
    b.send({ t: 'cmd', c: 'faster' })
    await waitFor(() => got.some((m) => m.t === 'cmd'), 'real channel')
    a.close()
    b.close()
  })
})
