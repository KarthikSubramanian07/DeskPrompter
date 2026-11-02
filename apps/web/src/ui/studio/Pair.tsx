/**
 * "Pair a phone": a QR code that turns a phone into the remote, and a button
 * that opens a talent window for a second screen.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { HostBridge } from '../../core/bridge'
import { formatRoomCode } from '../../link/code'
import { qrSvg } from '../../link/qr'

const STATUS: Record<string, string> = {
  idle: 'Starting…',
  connecting: 'Opening a room…',
  waiting: 'Waiting for your phone',
  p2p: 'Phone connected, directly',
  relay: 'Phone connected, through the relay',
  closed: 'Disconnected. Retrying…',
  error: 'Couldn’t open a room. Check your connection.',
}

export function PairButton({ bridge }: { bridge: HostBridge }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const phones = bridge.peers.value.filter((p) => p.role === 'remote').length
  const connected = phones > 0

  useEffect(() => {
    if (!open) return
    const onDoc = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div class="pair" ref={box}>
      <button class={`bar-btn ${connected ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <rect x="4" y="1.5" width="8" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M7 12.2h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        {connected ? `Phone connected` : 'Pair a phone'}
        {connected && <span class="pair-dot" />}
      </button>
      {open && <PairPanel bridge={bridge} />}
    </div>
  )
}

function PairPanel({ bridge }: { bridge: HostBridge }) {
  const url = useMemo(() => bridge.pair(), [bridge])
  const svg = useMemo(() => qrSvg(url, { style: 'rounded', margin: 1 }), [url])
  const status = bridge.remoteStatus.value
  const phones = bridge.peers.value.filter((p) => p.role === 'remote')
  const label = phones.length ? (phones.some((p) => p.via === 'p2p') ? STATUS.p2p : STATUS.relay) : (STATUS[status] ?? status)
  return (
    <div class="pair-panel" role="dialog" aria-label="Pair a phone">
      <p class="pair-title">Use your phone as the remote</p>
      <div class="pair-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <p class="pair-code">
        or open <a href={url} target="_blank" rel="noreferrer">{location.host}/remote</a> and enter{' '}
        <strong>{bridge.code.value ? formatRoomCode(bridge.code.value) : '…'}</strong>
      </p>
      <p class={`pair-status ${phones.length ? 'ok' : ''}`}>
        <span class="pair-status-dot" />
        {label}
      </p>
      <p class="pair-fine">Commands go phone-to-laptop. Your script never leaves this computer.</p>
    </div>
  )
}

export function TalentButton() {
  const open = () => {
    const w = window.open('/studio?display=1&mirror=1', 'deskprompter-talent', 'popup,width=1280,height=800')
    w?.focus()
  }
  return (
    <button class="bar-btn" onClick={open} title="Open a mirrored window for a second screen or glass rig">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      Talent window
    </button>
  )
}
