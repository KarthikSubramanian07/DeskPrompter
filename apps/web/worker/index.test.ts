import { describe, expect, it } from 'vitest'
import { handle, type Env } from './index'

/** A stand-in for Pages' asset binding: a few files, 404.html for everything else. */
function assets(files: Record<string, { body: string; type: string }>): Env {
  return {
    ASSETS: {
      async fetch(input: Request | URL | string) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const path = url.pathname === '/' ? '/index.html' : url.pathname
        const hit = files[path] ?? files[`${path}.html`]
        if (hit) return new Response(hit.body, { status: 200, headers: { 'Content-Type': hit.type } })
        return new Response('<h1>404</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } })
      },
    },
  }
}

const env = assets({
  '/index.html': { body: '<h1>DeskPrompter</h1>', type: 'text/html; charset=utf-8' },
  '/index.md': { body: '# DeskPrompter\n\nA teleprompter that listens.', type: 'text/markdown' },
  '/404.md': { body: '# Not found\n\nSee /llms.txt', type: 'text/markdown' },
  '/og.png': { body: 'png', type: 'image/png' },
})

const get = (path: string, accept?: string, method = 'GET') =>
  handle(new Request(`https://deskprompter.pages.dev${path}`, { method, headers: accept ? { Accept: accept } : {} }), env)

describe('worker', () => {
  it('serves Markdown with the right headers when asked', async () => {
    const res = await get('/', 'text/markdown')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('Vary')).toBe('Accept')
    expect(await res.text()).toContain('# DeskPrompter')
  })
  it('keeps HTML for browsers, with Vary and a Markdown alternate link', async () => {
    const res = await get('/', 'text/html')
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Vary')).toBe('Accept')
    expect(res.headers.get('Link')).toBe('</index.md>; rel="alternate"; type="text/markdown"')
    expect(await res.text()).toContain('<h1>')
  })
  it('answers unknown pages with a Markdown 404 for agents', async () => {
    const res = await get('/nope', 'text/markdown')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(await res.text()).toContain('/llms.txt')
  })
  it('keeps the HTML 404 for browsers', async () => {
    const res = await get('/nope', 'text/html')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })
  it('adds cross-origin isolation to every response', async () => {
    for (const res of [await get('/'), await get('/', 'text/markdown'), await get('/og.png')]) {
      expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
      expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    }
  })
  it('does not add Vary to plain files', async () => {
    const res = await get('/og.png', 'text/markdown')
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Vary')).toBeNull()
  })
  it('answers HEAD without a body', async () => {
    const res = await get('/', 'text/markdown', 'HEAD')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
