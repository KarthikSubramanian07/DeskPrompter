/**
 * Same-device link between windows of the app (operator window ↔ talent
 * display on a second screen) over BroadcastChannel. Nothing leaves the
 * machine, so the status is always `local`.
 */

import type { Link, LinkMessage, LinkRole, LinkStatus } from '../core/contracts'
import { createEmitter } from './emitter'
import { parseLinkMessage } from './message'

/** The subset of BroadcastChannel we use (lets tests inject a fake). */
export interface ChannelLike {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((ev: MessageEvent) => void) | null
}

export interface LocalLinkOptions {
  createChannel?: (name: string) => ChannelLike
  /** Optional display name sent in the initial hello. */
  name?: string
}

export function createLocalLink(role: LinkRole, channel = 'deskprompter', opts: LocalLinkOptions = {}): Link {
  const make = opts.createChannel ?? ((name: string) => new BroadcastChannel(name) as ChannelLike)
  const messages = createEmitter<LinkMessage>()
  const statuses = createEmitter<LinkStatus>()
  let status: LinkStatus = 'local'
  const bc = make(channel)

  bc.onmessage = (ev) => {
    const msg = parseLinkMessage(ev.data)
    if (msg) messages.emit(msg)
  }

  const post = (msg: LinkMessage) => {
    try {
      bc.postMessage(msg)
    } catch (err) {
      console.warn('[link] local post failed', err)
    }
  }

  post(opts.name ? { t: 'hello', role, name: opts.name } : { t: 'hello', role })

  return {
    get status() {
      return status
    },
    send(msg) {
      if (status === 'closed') return
      post(msg)
    },
    onMessage: messages.on,
    onStatus: statuses.on,
    close() {
      if (status === 'closed') return
      post({ t: 'bye' })
      bc.onmessage = null
      bc.close()
      status = 'closed'
      statuses.emit(status)
      messages.clear()
      statuses.clear()
    },
  }
}
