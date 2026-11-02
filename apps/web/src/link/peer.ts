/**
 * One WebRTC data channel between two peers. Signaling (SDP and ICE) goes out
 * through `onSignal` and comes back in through `handleSignal`; the relay
 * carries it. The channel is pre-negotiated (id 0) so both sides create it
 * symmetrically and there is no `ondatachannel` race.
 */

import { ICE_SERVERS } from './config'

export type SignalData =
  | { type: 'offer' | 'answer'; sdp: string }
  | { candidate: RTCIceCandidateInit | null }

export type RTCPeerConnectionCtor = new (config?: RTCConfiguration) => RTCPeerConnection

export interface PeerChannelOptions {
  /** The initiator creates the offer (guests offer, the host answers). */
  initiator: boolean
  RTC: RTCPeerConnectionCtor
  iceServers?: RTCIceServer[]
  onSignal(data: SignalData): void
  onOpen(): void
  onClose(): void
  onMessage(text: string): void
}

export function parseSignal(v: unknown): SignalData | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as Record<string, unknown>
  if ((d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length < 64_000) {
    return { type: d.type, sdp: d.sdp }
  }
  if ('candidate' in d) {
    if (d.candidate === null) return { candidate: null }
    if (typeof d.candidate === 'object' && d.candidate !== null) {
      const c = d.candidate as Record<string, unknown>
      if (typeof c.candidate !== 'string') return null
      return {
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
          sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
        },
      }
    }
  }
  return null
}

export class PeerChannel {
  private pc: RTCPeerConnection
  private dc: RTCDataChannel
  private queue: Promise<void> = Promise.resolve()
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteSet = false
  private done = false
  private opened = false

  constructor(private opts: PeerChannelOptions) {
    this.pc = new opts.RTC({ iceServers: opts.iceServers ?? ICE_SERVERS })
    this.dc = this.pc.createDataChannel('deskprompter', { negotiated: true, id: 0, ordered: true })
    this.pc.onicecandidate = (e) => {
      if (!this.done) opts.onSignal({ candidate: e.candidate ? e.candidate.toJSON() : null })
    }
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.close()
    }
    this.dc.onopen = () => {
      if (this.done) return
      this.opened = true
      opts.onOpen()
    }
    this.dc.onclose = () => this.close()
    this.dc.onmessage = (e) => {
      if (typeof e.data === 'string') opts.onMessage(e.data)
    }
  }

  get open(): boolean {
    return this.opened && !this.done && this.dc.readyState === 'open'
  }

  /** Initiator only: create and send the offer. */
  start(): Promise<void> {
    return this.serial(async () => {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      const sdp = this.pc.localDescription?.sdp ?? offer.sdp ?? ''
      this.opts.onSignal({ type: 'offer', sdp })
    })
  }

  handleSignal(data: SignalData): Promise<void> {
    return this.serial(async () => {
      if ('type' in data) {
        if (data.type === 'offer' && this.opts.initiator) return
        if (data.type === 'answer' && !this.opts.initiator) return
        await this.pc.setRemoteDescription({ type: data.type, sdp: data.sdp })
        this.remoteSet = true
        for (const c of this.pendingCandidates.splice(0)) await this.addCandidate(c)
        if (data.type === 'offer') {
          const answer = await this.pc.createAnswer()
          await this.pc.setLocalDescription(answer)
          this.opts.onSignal({ type: 'answer', sdp: this.pc.localDescription?.sdp ?? answer.sdp ?? '' })
        }
      } else if (data.candidate) {
        if (this.remoteSet) await this.addCandidate(data.candidate)
        else this.pendingCandidates.push(data.candidate)
      }
    })
  }

  send(text: string): boolean {
    if (!this.open) return false
    try {
      this.dc.send(text)
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.done) return
    this.done = true
    try {
      this.dc.close()
    } catch {}
    try {
      this.pc.close()
    } catch {}
    this.opts.onClose()
  }

  private async addCandidate(c: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(c)
    } catch {
      // A stale or unparseable candidate should not take the connection down.
    }
  }

  private serial(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.done) return
      try {
        await task()
      } catch (err) {
        console.warn('[link] webrtc negotiation failed', err)
        this.close()
      }
    })
    return this.queue
  }
}
