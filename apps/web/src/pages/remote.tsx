/**
 * Phone remote. Opened from the prompter's QR code as `/remote?c=CODE`, it
 * joins the room as a `remote`, mirrors the host's PrompterSnapshot, and sends
 * RemoteCommands. Built for one thumb: the controls sit at the bottom.
 */

import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/newsreader'
import './remote.css'

import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { LinkStatus, PrompterSnapshot, RemoteCommand } from '../core/contracts'
import { formatRoomCode, normalizeRoomCode } from '../link/code'
import { createRemoteLink, type RemoteLink } from '../link/relay'
import { useLink } from '../link/useLink'

const STATUS_LABEL: Record<LinkStatus, string> = {
  idle: 'Starting',
  connecting: 'Connecting',
  waiting: 'Waiting for prompter',
  p2p: 'Direct',
  relay: 'Relayed',
  local: 'Local',
  closed: 'Disconnected',
  error: 'Room unavailable',
}

const STATUS_HINT: Partial<Record<LinkStatus, string>> = {
  waiting: 'Open DeskPrompter on your computer and keep this page open.',
  p2p: 'Peer-to-peer. Nothing passes through our server.',
  relay: 'Your network blocks direct links, so commands go through the relay.',
  error: 'The room is full or the code is wrong.',
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const buzz = (pattern: number | number[] = 8) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Some browsers throw when vibration is blocked by policy.
  }
}

/** Keeps the phone awake while the remote is in use (where supported). */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let disposed = false
    const acquire = async () => {
      if (disposed || lock || document.visibilityState !== 'visible') return
      try {
        lock = await navigator.wakeLock.request('screen')
        lock.addEventListener('release', () => (lock = null))
        if (disposed) void lock.release()
      } catch {
        // Denied (battery saver, iframe policy): the remote still works.
      }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
    }
  }, [active])
}

function readCode(): string | null {
  return normalizeRoomCode(new URLSearchParams(location.search).get('c'))
}

function App() {
  const [code, setCode] = useState<string | null>(readCode)

  useEffect(() => {
    const onPop = () => setCode(readCode())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const join = (next: string) => {
    history.pushState(null, '', `${location.pathname}?c=${next}`)
    setCode(next)
  }

  return code ? <Remote code={code} key={code} /> : <JoinForm onJoin={join} />
}

function JoinForm({ onJoin }: { onJoin: (code: string) => void }) {
  const [value, setValue] = useState('')
  const code = normalizeRoomCode(value)
  return (
    <main class="remote remote--join">
      <header class="remote__bar">
        <span class="remote__brand">DeskPrompter</span>
        <span class="remote__label">Remote</span>
      </header>
      <form
        class="join"
        onSubmit={(e) => {
          e.preventDefault()
          if (code) onJoin(code)
        }}
      >
        <h1 class="join__title">Pair with your prompter</h1>
        <p class="join__hint">Scan the QR code on your computer, or type the six-character room code.</p>
        <label class="remote__label" for="room-code">
          Room code
        </label>
        <input
          id="room-code"
          class="join__input"
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value.toUpperCase())}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          maxLength={7}
          placeholder="K7P-Q2M"
          aria-invalid={value.length >= 6 && !code}
        />
        <button class="btn btn--primary join__go" type="submit" disabled={!code}>
          Connect
        </button>
      </form>
    </main>
  )
}

function Remote({ code }: { code: string }) {
  const { link, status, snapshot, send } = useLink(() => createRemoteLink({ code, role: 'remote' }), code)
  const connected = status === 'p2p' || status === 'relay'
  useWakeLock(connected)

  const cmd = (c: RemoteCommand, haptic: number | number[] = 8) => {
    if (!connected) return
    buzz(haptic)
    send({ t: 'cmd', ...c })
  }

  // Hardware keyboards and presentation clickers (which send arrows/space).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      const map: Record<string, RemoteCommand> = {
        ' ': { c: 'toggle' },
        ArrowUp: { c: 'faster' },
        ArrowDown: { c: 'slower' },
        ArrowLeft: { c: 'back' },
        ArrowRight: { c: 'forward' },
        PageUp: { c: 'back' },
        PageDown: { c: 'forward' },
      }
      const c = map[e.key]
      if (!c) return
      e.preventDefault()
      cmd(c)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <main class="remote" data-status={status}>
      <header class="remote__bar">
        <span class="remote__brand">DeskPrompter</span>
        <span class="remote__code" aria-label={`Room ${code.split('').join(' ')}`}>
          {formatRoomCode(code)}
        </span>
      </header>

      <section class="status" aria-live="polite">
        <span class={`status__dot status__dot--${status}`} aria-hidden="true" />
        <span class="status__label">{STATUS_LABEL[status]}</span>
        {STATUS_HINT[status] && <span class="status__hint">{STATUS_HINT[status]}</span>}
        {(status === 'error' || status === 'closed') && (
          <button class="btn btn--ghost status__retry" type="button" onClick={() => (link as RemoteLink | null)?.reconnect()}>
            Try again
          </button>
        )}
      </section>

      <Glance snapshot={connected ? snapshot : null} connected={connected} />

      <section class="controls" aria-label="Prompter controls">
        <div class="controls__row">
          <button class="btn btn--icon" type="button" disabled={!connected} onClick={() => cmd({ c: 'back' })} aria-label="Back one line">
            <Icon name="back" />
          </button>
          <button class="btn btn--icon" type="button" disabled={!connected} onClick={() => cmd({ c: 'slower' })} aria-label="Slower">
            <Icon name="minus" />
          </button>
          <output class="speed" aria-label="Speed">
            <span class="remote__label">Speed</span>
            <span class="speed__value">{snapshot && connected ? snapshot.speed.toFixed(1).replace(/\.0$/, '') : '–'}</span>
          </output>
          <button class="btn btn--icon" type="button" disabled={!connected} onClick={() => cmd({ c: 'faster' })} aria-label="Faster">
            <Icon name="plus" />
          </button>
          <button class="btn btn--icon" type="button" disabled={!connected} onClick={() => cmd({ c: 'forward' })} aria-label="Forward one line">
            <Icon name="forward" />
          </button>
        </div>
        <button
          class={`btn btn--primary play${snapshot?.playing ? ' play--playing' : ''}`}
          type="button"
          disabled={!connected}
          aria-pressed={!!snapshot?.playing}
          onClick={() => cmd({ c: 'toggle' }, 16)}
        >
          <Icon name={snapshot?.playing ? 'pause' : 'play'} />
          <span>{snapshot?.playing ? 'Pause' : 'Play'}</span>
        </button>
        <div class="controls__row controls__row--minor">
          <button class="btn btn--ghost" type="button" disabled={!connected} onClick={() => cmd({ c: 'top' })}>
            Back to top
          </button>
          <button
            class="btn btn--ghost"
            type="button"
            disabled={!connected}
            aria-pressed={!!snapshot?.mirrorX}
            onClick={() => cmd({ c: 'mirror' })}
          >
            Mirror
          </button>
        </div>
      </section>
    </main>
  )
}

function Glance({ snapshot, connected }: { snapshot: PrompterSnapshot | null; connected: boolean }) {
  if (!snapshot) {
    return (
      <section class="glance glance--empty">
        <p class="glance__line">{connected ? 'Connected. Waiting for the prompter to share where it is.' : 'Your script appears here once the prompter connects.'}</p>
      </section>
    )
  }
  const pct = Math.round(snapshot.progress * 100)
  return (
    <section class="glance" aria-label="Now reading">
      <div class="glance__meta">
        <span class="remote__label glance__title">{snapshot.title || 'Untitled script'}</span>
        <span class="remote__label">{snapshot.mode === 'manual' ? `${Math.round(snapshot.wpm)} wpm` : snapshot.mode}</span>
      </div>
      <p class="glance__line">{snapshot.currentLine || '…'}</p>
      <div class="progress">
        <div class="progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Script progress">
          <div class="progress__fill" style={{ transform: `scaleX(${snapshot.progress})` }} />
        </div>
        <div class="progress__times">
          <span>{formatTime(snapshot.elapsedMs)}</span>
          <span>{pct}%</span>
          <span>−{formatTime(snapshot.remainingMs)}</span>
        </div>
      </div>
    </section>
  )
}

type IconName = 'play' | 'pause' | 'back' | 'forward' | 'plus' | 'minus'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    back: 'M11 7l-5 5 5 5M18 7l-5 5 5 5',
    forward: 'M13 7l5 5-5 5M6 7l5 5-5 5',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
  }
  const filled = name === 'play' || name === 'pause'
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={paths[name]}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

render(<App />, document.getElementById('app')!)
