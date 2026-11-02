/** A tiny typed event emitter shared by the speech engines. */
export class Emitter<E> {
  private readonly subs = new Map<keyof E, Set<(payload: never) => void>>()

  on<K extends keyof E>(event: K, cb: (payload: E[K]) => void): () => void {
    let set = this.subs.get(event)
    if (!set) this.subs.set(event, (set = new Set()))
    set.add(cb as (payload: never) => void)
    return () => void set.delete(cb as (payload: never) => void)
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.subs.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        ;(cb as (payload: E[K]) => void)(payload)
      } catch (err) {
        // A broken listener must not stop recognition for everyone else.
        console.error(err)
      }
    }
  }
}

/** Collapse whitespace the way every engine should before emitting text. */
export const cleanText = (s: string): string => s.replace(/\s+/g, ' ').trim()
