/**
 * Content negotiation for agents (https://acceptmarkdown.com).
 *
 * A request that prefers `text/markdown` over `text/html` gets the Markdown
 * twin of the page. Everything else gets HTML. Pure functions, so the rules
 * are unit tested without a Workers runtime.
 */

/** Pages that have a Markdown twin, by clean path. */
export const MARKDOWN_PAGES: Record<string, string> = {
  '/': '/index.md',
  '/studio': '/studio.md',
  '/about': '/about.md',
  '/contact': '/contact.md',
  '/privacy': '/privacy.md',
}

export const NOT_FOUND_MARKDOWN = '/404.md'

interface MediaRange {
  type: string
  subtype: string
  q: number
}

export function parseAccept(header: string | null | undefined): MediaRange[] {
  if (!header) return []
  const out: MediaRange[] = []
  for (const part of header.split(',')) {
    const [range, ...params] = part.trim().split(';')
    const [type, subtype] = (range ?? '').trim().toLowerCase().split('/')
    if (!type || !subtype) continue
    let q = 1
    for (const p of params) {
      const [k, v] = p.trim().split('=')
      if (k?.trim().toLowerCase() === 'q') {
        const n = Number(v)
        q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
      }
    }
    out.push({ type, subtype, q })
  }
  return out
}

/** Quality for a concrete type, using the most specific matching range. */
function qualityFor(ranges: MediaRange[], type: string, subtype: string, allowWildcardAll: boolean): number {
  let best = -1
  let specificity = -1
  for (const r of ranges) {
    let s = -1
    if (r.type === type && r.subtype === subtype) s = 2
    else if (r.type === type && r.subtype === '*') s = 1
    else if (allowWildcardAll && r.type === '*' && r.subtype === '*') s = 0
    if (s > specificity) {
      specificity = s
      best = r.q
    }
  }
  return best < 0 ? 0 : best
}

/**
 * True when the client asked for Markdown at least as much as HTML.
 * `*\/*` alone (curl's default, browsers' fallback) never selects Markdown.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  const ranges = parseAccept(accept)
  const md = Math.max(qualityFor(ranges, 'text', 'markdown', false), qualityFor(ranges, 'text', 'x-markdown', false))
  if (md <= 0) return false
  const html = qualityFor(ranges, 'text', 'html', true)
  return md >= html
}

/** `/about/`, `/about.html` and `/about` are the same page. */
export function cleanPath(pathname: string): string {
  let p = pathname.replace(/\/{2,}/g, '/')
  if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length)
  else if (p.endsWith('.html')) p = p.slice(0, -'.html'.length)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p || '/'
}

/** A path that names a page rather than a file (no extension in the last segment). */
export function isPagePath(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? ''
  return !last.includes('.') || last.endsWith('.html')
}

export type Route = { kind: 'markdown'; asset: string; status: 200 | 404 } | { kind: 'passthrough' }

export function route(method: string, pathname: string, accept: string | null | undefined): Route {
  if ((method !== 'GET' && method !== 'HEAD') || !prefersMarkdown(accept) || !isPagePath(pathname)) return { kind: 'passthrough' }
  const md = MARKDOWN_PAGES[cleanPath(pathname)]
  return md ? { kind: 'markdown', asset: md, status: 200 } : { kind: 'markdown', asset: NOT_FOUND_MARKDOWN, status: 404 }
}
