/**
 * iOS and iPadOS only let audio run after a user gesture, and a context created
 * after an `await` has lost that gesture. Every context we make registers here,
 * and the next tap or key press resumes whichever ones are still suspended.
 */
const contexts = new Set<AudioContext>()
let listening = false

function resumeAll() {
  for (const ctx of contexts) {
    if (ctx.state === 'closed') contexts.delete(ctx)
    else if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  }
}

export function registerAudioContext(ctx: AudioContext): AudioContext {
  contexts.add(ctx)
  if (!listening && typeof window !== 'undefined') {
    listening = true
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, resumeAll, { capture: true, passive: true })
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && resumeAll())
  }
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  return ctx
}
