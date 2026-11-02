/**
 * The host side of every device link. The studio owns one bridge: it always
 * listens on a same-device channel (talent windows), and opens a relay room
 * for phones when you ask to pair. It fans state out and commands in.
 */
import { signal } from '@preact/signals'
import type { Link, LinkMessage, LinkStatus, PrompterSnapshot, RemoteCommand } from './contracts'
import { createLocalLink } from '../link/broadcast'
import { generateRoomCode, pairUrl } from '../link/code'
import { createRemoteLink, type RemoteLink } from '../link/relay'

export interface Peer {
  id: string
  role: string
  via: string
}

export class HostBridge {
  readonly local: Link
  remote: RemoteLink | null = null
  readonly code = signal<string | null>(null)
  readonly remoteStatus = signal<LinkStatus>('idle')
  readonly peers = signal<Peer[]>([])
  readonly displays = signal(0)
  private commandHandlers = new Set<(c: RemoteCommand) => void>()
  private lastState: PrompterSnapshot | null = null
  private script: { title: string; text: string } = { title: '', text: '' }
  private lastRemoteSend = 0

  constructor() {
    this.local = createLocalLink('host')
    this.local.onMessage((m) => this.onMessage(m, this.local))
  }

  /** Open (or reuse) a relay room for phones. Returns the URL to put in the QR code. */
  pair(): string {
    if (!this.remote) {
      const code = generateRoomCode()
      this.code.value = code
      const link = createRemoteLink({ code, role: 'host', name: 'DeskPrompter' })
      this.remote = link
      this.remoteStatus.value = link.status
      link.onStatus((s) => {
        this.remoteStatus.value = s
        this.refreshPeers()
      })
      link.onMessage((m) => {
        this.refreshPeers()
        this.onMessage(m, link)
      })
    }
    return pairUrl(this.code.value!)
  }

  unpair() {
    this.remote?.close()
    this.remote = null
    this.code.value = null
    this.remoteStatus.value = 'idle'
    this.peers.value = []
  }

  private refreshPeers() {
    this.peers.value = this.remote?.peers() ?? []
  }

  onCommand(cb: (c: RemoteCommand) => void): () => void {
    this.commandHandlers.add(cb)
    return () => this.commandHandlers.delete(cb)
  }

  setScript(title: string, text: string) {
    if (title === this.script.title && text === this.script.text) return
    this.script = { title, text }
    this.local.send({ t: 'script', title, text })
  }

  /** Called ~10x a second by the stage. Phones get ~4 updates a second. */
  publish(s: PrompterSnapshot) {
    this.lastState = s
    this.local.send({ t: 'state', s })
    const now = performance.now()
    if (this.remote && now - this.lastRemoteSend > 240) {
      this.lastRemoteSend = now
      // Script text only travels peer to peer. If any phone is reached through
      // the relay, it gets timing and controls but not the words.
      const direct = this.remote.peers().every((p) => p.via === 'p2p')
      this.remote.send({ t: 'state', s: direct ? s : { ...s, title: '', currentLine: '' } })
    }
  }

  private onMessage(m: LinkMessage, from: Link) {
    if (m.t === 'cmd') {
      const { t: _t, ...cmd } = m
      for (const h of this.commandHandlers) h(cmd as RemoteCommand)
    } else if (m.t === 'hello') {
      if (m.role === 'display') {
        this.displays.value += 1
        from.send({ t: 'script', ...this.script })
      }
      if (this.lastState) from.send({ t: 'state', s: this.lastState })
    }
  }

  close() {
    this.local.send({ t: 'bye' })
    this.local.close()
    this.unpair()
  }
}
