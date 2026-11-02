import { describe, expect, it } from 'vitest'
import { cleanPath, isPagePath, parseAccept, prefersMarkdown, route } from './negotiate'

describe('prefersMarkdown', () => {
  it('selects Markdown when asked for it', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true)
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true)
    expect(prefersMarkdown('text/html;q=0.5, text/markdown')).toBe(true)
    expect(prefersMarkdown('text/x-markdown')).toBe(true)
  })
  it('keeps HTML for browsers, curl and HTML-first clients', () => {
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(false)
    expect(prefersMarkdown('*/*')).toBe(false)
    expect(prefersMarkdown(undefined)).toBe(false)
    expect(prefersMarkdown('text/html')).toBe(false)
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false)
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false)
  })
  it('parses q-values defensively', () => {
    expect(parseAccept('text/markdown;q=abc, text/html;q=2')).toEqual([
      { type: 'text', subtype: 'markdown', q: 1 },
      { type: 'text', subtype: 'html', q: 1 },
    ])
  })
})

describe('paths', () => {
  it('normalizes clean URLs', () => {
    expect(cleanPath('/')).toBe('/')
    expect(cleanPath('/index.html')).toBe('/')
    expect(cleanPath('/about/')).toBe('/about')
    expect(cleanPath('/about.html')).toBe('/about')
    expect(cleanPath('//studio')).toBe('/studio')
  })
  it('tells pages from files', () => {
    expect(isPagePath('/studio')).toBe(true)
    expect(isPagePath('/about.html')).toBe(true)
    expect(isPagePath('/og.png')).toBe(false)
    expect(isPagePath('/llms.txt')).toBe(false)
  })
})

describe('route', () => {
  const md = 'text/markdown'
  it('maps known pages to their Markdown twins', () => {
    expect(route('GET', '/', md)).toEqual({ kind: 'markdown', asset: '/index.md', status: 200 })
    expect(route('GET', '/studio', md)).toEqual({ kind: 'markdown', asset: '/studio.md', status: 200 })
    expect(route('HEAD', '/privacy/', md)).toEqual({ kind: 'markdown', asset: '/privacy.md', status: 200 })
  })
  it('answers unknown pages with a Markdown 404', () => {
    expect(route('GET', '/no-such-page', md)).toEqual({ kind: 'markdown', asset: '/404.md', status: 404 })
  })
  it('leaves files, HTML requests and other methods alone', () => {
    expect(route('GET', '/og.png', md)).toEqual({ kind: 'passthrough' })
    expect(route('GET', '/', 'text/html')).toEqual({ kind: 'passthrough' })
    expect(route('POST', '/', md)).toEqual({ kind: 'passthrough' })
  })
})
