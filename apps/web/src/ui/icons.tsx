import type { PrompterMode } from '../core/contracts'

const P = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const

/** Steady: lines gliding up. Voice: a waveform. Breath: a slow swell. */
export function ModeIcon({ mode, size = 16 }: { mode: PrompterMode; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      {mode === 'manual' && (
        <g {...P}>
          <path d="M3 4h10M3 8h10M3 12h6" />
          <path d="M12.5 10.5v3.5M11 12.5l1.5 1.5 1.5-1.5" />
        </g>
      )}
      {mode === 'voice' && (
        <g {...P}>
          <path d="M2.5 7v2M5.25 4.5v7M8 2.5v11M10.75 4.5v7M13.5 7v2" />
        </g>
      )}
      {mode === 'breath' && (
        <g {...P}>
          <path d="M1.5 9.5c1.6 0 2.2-4.5 4.4-4.5s2.4 6 4.6 6 2.4-3.5 4-3.5" />
        </g>
      )}
    </svg>
  )
}
