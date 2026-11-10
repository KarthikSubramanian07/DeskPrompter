/**
 * One switch for the landing page's ambient motion (the drifting lamp and the demo), so
 * anything that moves on its own for more than five seconds can be paused (WCAG 2.2.2).
 * It starts paused when the system asks for reduced motion.
 */
import { signal } from '@preact/signals'

export const motionPaused = signal(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

export function MotionToggle({ class: cls = '' }: { class?: string }) {
  const paused = motionPaused.value
  return (
    <button type="button" class={`motion-toggle ${cls}`} aria-pressed={paused} onClick={() => (motionPaused.value = !paused)}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {paused ? (
          <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
        ) : (
          <path d="M5 3.5v9M11 3.5v9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        )}
      </svg>
      Pause animation
    </button>
  )
}
