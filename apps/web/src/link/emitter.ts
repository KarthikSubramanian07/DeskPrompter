/** Minimal typed listener set. */
export function createEmitter<T>() {
  const listeners = new Set<(value: T) => void>()
  return {
    on(cb: (value: T) => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit(value: T) {
      for (const cb of [...listeners]) {
        try {
          cb(value)
        } catch (err) {
          console.error('[link] listener failed', err)
        }
      }
    },
    clear() {
      listeners.clear()
    },
  }
}
