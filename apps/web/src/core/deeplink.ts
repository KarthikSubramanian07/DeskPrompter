/**
 * Open a script from a link: /studio#title=...&script=...
 *
 * The script rides in the URL fragment, which browsers never send to a server,
 * so an agent can hand someone a ready-to-read script without anything being
 * uploaded. Returns null when the fragment carries no script.
 */
export interface LinkedScript {
  title: string
  text: string
}

export const MAX_LINKED_SCRIPT = 200_000

export function readLinkedScript(hash: string): LinkedScript | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return null
  }
  const text = (params.get('script') ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  const title = (params.get('title') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return { title: title || 'From a link', text: text.slice(0, MAX_LINKED_SCRIPT) }
}

/** Build a link that opens `text` in the studio (used by docs and tests). */
export function linkForScript(text: string, title = '', origin = 'https://deskprompter.pages.dev'): string {
  const p = new URLSearchParams()
  if (title) p.set('title', title)
  p.set('script', text)
  return `${origin}/studio#${p.toString()}`
}
