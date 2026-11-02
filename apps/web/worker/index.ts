/**
 * Cloudflare Pages advanced-mode worker (built to dist/_worker.js).
 *
 * - Markdown for agents: `Accept: text/markdown` gets the page's Markdown twin
 *   (or a Markdown 404), with `Content-Type: text/markdown` and `Vary: Accept`.
 * - Everything else is the static site, unchanged, plus the headers `_headers`
 *   used to provide (Pages skips `_headers` once a worker handles requests).
 */
import { cleanPath, isPagePath, MARKDOWN_PAGES, route } from './negotiate'

export interface Env {
  ASSETS: { fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> }
}

/** Cross-origin isolation for Moonshine's threaded WebAssembly, on every response. */
export const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function withHeaders(res: Response, extra: Record<string, string>, varyAccept: boolean): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) out.headers.set(k, v)
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v)
  if (varyAccept) {
    const vary = out.headers.get('Vary')
    if (!vary) out.headers.set('Vary', 'Accept')
    else if (!/\baccept\b/i.test(vary)) out.headers.set('Vary', `${vary}, Accept`)
  }
  return out
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const r = route(request.method, url.pathname, request.headers.get('Accept'))

  if (r.kind === 'markdown') {
    const asset = await env.ASSETS.fetch(new URL(r.asset, url.origin))
    if (asset.ok) {
      const body = request.method === 'HEAD' ? null : await asset.text()
      return withHeaders(
        new Response(body, { status: r.status }),
        {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
        true,
      )
    }
  }

  const res = await env.ASSETS.fetch(request)
  // Pages that have a Markdown twin vary by Accept, and say where the twin lives.
  const page = isPagePath(url.pathname)
  const twin = page ? MARKDOWN_PAGES[cleanPath(url.pathname)] : undefined
  const extra: Record<string, string> = {}
  if (twin) extra.Link = `<${twin}>; rel="alternate"; type="text/markdown"`
  return withHeaders(res, extra, page)
}

export default { fetch: handle }
