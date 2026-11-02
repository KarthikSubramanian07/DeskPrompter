/**
 * Preact hook: owns a Link for the component's lifetime and exposes its
 * status, the latest host snapshot, and a stable `send`.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Link, LinkMessage, LinkStatus, PrompterSnapshot } from '../core/contracts'

export interface UseLink {
  link: Link | null
  status: LinkStatus
  snapshot: PrompterSnapshot | null
  send: (msg: LinkMessage) => void
}

/**
 * `factory` runs once per `key` (e.g. the room code); returning null skips
 * connecting. `onMessage` sees every validated message.
 */
export function useLink(
  factory: () => Link | null,
  key: unknown,
  onMessage?: (msg: LinkMessage) => void,
): UseLink {
  const [link, setLink] = useState<Link | null>(null)
  const [status, setStatus] = useState<LinkStatus>('idle')
  const [snapshot, setSnapshot] = useState<PrompterSnapshot | null>(null)
  const handler = useRef(onMessage)
  handler.current = onMessage

  useEffect(() => {
    const l = factory()
    setLink(l)
    if (!l) {
      setStatus('idle')
      return
    }
    setStatus(l.status)
    const offStatus = l.onStatus(setStatus)
    const offMsg = l.onMessage((msg) => {
      if (msg.t === 'state') setSnapshot(msg.s)
      else if (msg.t === 'bye') setSnapshot(null)
      handler.current?.(msg)
    })
    return () => {
      offStatus()
      offMsg()
      l.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const linkRef = useRef(link)
  linkRef.current = link
  const send = useRef((msg: LinkMessage) => linkRef.current?.send(msg)).current

  return { link, status, snapshot, send }
}
