/**
 * Builds the static trust pages (about, contact, privacy) from their Markdown
 * twins in public/. The Markdown is the single source: agents get it via
 * content negotiation, people get this HTML. Run: bun run gen:pages
 */
import { marked } from 'marked'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRUST_PAGES = ['about', 'contact', 'privacy'] as const
export type TrustPage = (typeof TRUST_PAGES)[number]

const SITE = 'https://deskprompter.pages.dev'
const root = join(import.meta.dirname, '..')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** First paragraph of plain text, for the meta description. */
function summary(md: string): string {
  const para = md.split(/\n{2,}/).find((b) => b.trim() && !b.startsWith('#')) ?? ''
  const text = para.replace(/\*\*|`|\[|\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 158 ? `${text.slice(0, 155).replace(/\s+\S*$/, '')}...` : text
}

export function renderPage(page: TrustPage, md: string): string {
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? page).trim()
  const desc = summary(md)
  const body = marked.parse(md, { async: false, gfm: true }) as string
  const nav = TRUST_PAGES.map((p) => `<a href="/${p}"${p === page ? ' aria-current="page"' : ''}>${p[0]!.toUpperCase()}${p.slice(1)}</a>`).join('\n          ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)} · DeskPrompter</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#F4F1E9" />
    <link rel="canonical" href="${SITE}/${page}" />
    <link rel="alternate" type="text/markdown" href="/${page}.md" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="DeskPrompter" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${SITE}/${page}" />
    <meta property="og:image" content="${SITE}/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/src/styles/doc.css" />
  </head>
  <body class="doc day">
    <header class="doc-nav">
      <a class="doc-brand" href="/">DeskPrompter</a>
      <nav aria-label="Site">
          ${nav}
          <a class="doc-cta" href="/studio">Open the studio</a>
      </nav>
    </header>
    <main class="doc-main">
${body.replace(/^/gm, '      ').trimEnd()}
    </main>
    <footer class="doc-foot">
      <span>DeskPrompter is free and open source under the MIT license.</span>
      <a href="/llms.txt">For agents: llms.txt</a>
    </footer>
  </body>
</html>
`
}

export function readMarkdown(page: TrustPage): string {
  return readFileSync(join(root, 'public', `${page}.md`), 'utf8')
}

/** App pages whose raw HTML carries their Markdown twin until the app takes over. */
export const PRERENDERED = { 'index.html': 'index.md', 'studio.html': 'studio.md' } as const

const START = '<!-- prerender:start -->'
const END = '<!-- prerender:end -->'

export function prerenderBlock(md: string): string {
  const body = (marked.parse(md, { async: false, gfm: true }) as string).trimEnd()
  return `${START}
      <main class="prerender">
${body.replace(/^/gm, '        ')}
        <nav class="prerender-links" aria-label="More">
          <a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/privacy">Privacy</a> · <a href="/llms.txt">llms.txt</a>
        </nav>
      </main>
      ${END}`
}

/** Replace the prerender block inside an HTML file (between the markers). */
export function injectPrerender(html: string, md: string): string {
  const a = html.indexOf(START)
  const b = html.indexOf(END)
  if (a < 0 || b < a) throw new Error('prerender markers missing')
  return html.slice(0, a) + prerenderBlock(md) + html.slice(b + END.length)
}

if (process.argv[1]?.endsWith('pages.ts')) {
  for (const p of TRUST_PAGES) {
    writeFileSync(join(root, `${p}.html`), renderPage(p, readMarkdown(p)))
    console.log(`wrote ${p}.html`)
  }
  for (const [html, md] of Object.entries(PRERENDERED)) {
    const file = join(root, html)
    writeFileSync(file, injectPrerender(readFileSync(file, 'utf8'), readFileSync(join(root, 'public', md), 'utf8')))
    console.log(`prerendered ${html}`)
  }
}
