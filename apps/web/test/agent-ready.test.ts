// @vitest-environment node
/**
 * Agent readiness, pinned: raw HTML has real content, generated pages match
 * their Markdown sources, machine-readable files follow their formats.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { injectPrerender, PRERENDERED, readMarkdown, renderPage, TRUST_PAGES } from '../scripts/pages'
import { MARKDOWN_PAGES, NOT_FOUND_MARKDOWN } from '../worker/negotiate'

const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

/** Visible text of raw HTML, the way a crawler without JavaScript sees it. */
function rawText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const headings = (html: string) => [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]))

const PAGES = ['index.html', 'studio.html', ...TRUST_PAGES.map((p) => `${p}.html`)]

describe('content without JavaScript', () => {
  it.each(PAGES)('%s has at least 500 characters of raw text', (f) => {
    expect(rawText(read(f)).length).toBeGreaterThanOrEqual(500)
  })
  it.each(PAGES)('%s has one h1 and sequential heading levels', (f) => {
    const h = headings(read(f).replace(/<head[\s\S]*?<\/head>/i, ''))
    expect(h.filter((l) => l === 1)).toHaveLength(1)
    expect(h[0]).toBe(1)
    for (let i = 1; i < h.length; i++) expect(h[i]! - h[i - 1]!).toBeLessThanOrEqual(1)
  })
  it('names the product in the homepage title and h1', () => {
    const html = read('index.html')
    expect(html).toMatch(/<title>DeskPrompter: [^<]*teleprompter[^<]*<\/title>/i)
    expect(html).toMatch(/<h1>DeskPrompter: [^<]*teleprompter[^<]*<\/h1>/i)
  })
})

describe('generated pages stay in sync with their Markdown', () => {
  it.each(TRUST_PAGES)('%s.html matches public/%s.md', (p) => {
    expect(read(`${p}.html`)).toBe(renderPage(p, readMarkdown(p)))
  })
  it.each(Object.entries(PRERENDERED))('%s carries %s', (html, md) => {
    const current = read(html)
    expect(injectPrerender(current, read(`public/${md}`))).toBe(current)
  })
})

describe('Markdown twins', () => {
  it('exist for every negotiated page, plus a Markdown 404', () => {
    for (const md of [...Object.values(MARKDOWN_PAGES), NOT_FOUND_MARKDOWN]) {
      expect(existsSync(join(root, 'public', md)), md).toBe(true)
      expect(read(`public${md}`).trim().length).toBeGreaterThan(20)
    }
  })
  it('the Markdown 404 explains itself and links llms.txt and the sitemap', () => {
    const md = read(`public${NOT_FOUND_MARKDOWN}`)
    expect(md).toMatch(/^# /)
    expect(md).toContain('/llms.txt')
    expect(md).toContain('/sitemap.xml')
  })
  it.each(['about', 'contact', 'privacy'])('the %s page has at least 500 characters', (p) => {
    expect(read(`public/${p}.md`).length).toBeGreaterThanOrEqual(500)
  })
})

describe('llms.txt (llmstxt.org)', () => {
  const txt = read('public/llms.txt')
  it('has an H1 name, a blockquote summary and H2 sections', () => {
    const lines = txt.split('\n')
    expect(lines[0]).toBe('# DeskPrompter')
    expect(lines.find((l) => l.trim())?.startsWith('# ')).toBe(true)
    expect(txt).toMatch(/\n> .+/)
    expect(txt.match(/^## /gm)?.length).toBeGreaterThanOrEqual(2)
  })
  it('tells agents when to use DeskPrompter and how to hand off a script', () => {
    expect(txt).toContain('## When to use DeskPrompter')
    expect(txt).toContain('/studio#title=')
  })
  it('links only to Markdown twins that exist', () => {
    for (const m of txt.matchAll(/\]\(https:\/\/deskprompter\.pages\.dev(\/[^)]+\.md)\)/g)) {
      expect(existsSync(join(root, 'public', m[1]!)), m[1]).toBe(true)
    }
  })
})

describe('structured data and discovery', () => {
  const html = read('index.html')
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!))
  const nodes = blocks.flatMap((b) => b['@graph'] ?? [b])
  it('declares an Organization with a contact point', () => {
    const org = nodes.find((n) => n['@type'] === 'Organization')
    expect(org?.name).toBe('DeskPrompter')
    expect(org?.contactPoint?.contactType).toBeTruthy()
    expect(org?.contactPoint?.url).toBe('https://deskprompter.pages.dev/contact')
  })
  it('lists product keywords in JSON-LD and meta keywords', () => {
    expect(nodes.find((n) => n['@type'] === 'SoftwareApplication')?.keywords).toContain('teleprompter')
    expect(html).toMatch(/<meta name="keywords" content="[^"]*teleprompter/)
  })
  it('every page advertises its Markdown twin', () => {
    for (const [page, md] of Object.entries(MARKDOWN_PAGES)) {
      const file = page === '/' ? 'index.html' : `${page.slice(1)}.html`
      expect(read(file)).toContain(`<link rel="alternate" type="text/markdown" href="${md}" />`)
    }
  })
  it('the sitemap lists every public page', () => {
    const sitemap = read('public/sitemap.xml')
    for (const p of Object.keys(MARKDOWN_PAGES)) expect(sitemap).toContain(`<loc>https://deskprompter.pages.dev${p}</loc>`)
  })
})

describe('house style', () => {
  it('no em dashes in pages, Markdown or llms.txt', () => {
    const files = [...PAGES, 'public/llms.txt', ...[...Object.values(MARKDOWN_PAGES), NOT_FOUND_MARKDOWN].map((m) => `public${m}`)]
    for (const f of files) expect(read(f).includes('—'), f).toBe(false)
  })
})
