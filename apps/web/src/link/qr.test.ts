import { describe, expect, it } from 'vitest'
import { qrSvg } from './qr'

const url = 'https://deskprompter.pages.dev/remote?c=K7PQ2M'

describe('qrSvg', () => {
  it('renders a square SVG with currentColor modules and a small quiet zone', () => {
    const svg = qrSvg(url)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('fill="currentColor"')
    expect(svg).toContain('shape-rendering="crispEdges"')
    const [, size] = svg.match(/viewBox="0 0 (\d+) \1"/) ?? []
    // 47 bytes needs version 4 (33 modules) at level M, plus 2 quiet modules a side.
    expect(Number(size)).toBe(37)
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)[^"]*\.(png|svg)/)
  })

  it('honours margin and error correction', () => {
    const tight = qrSvg('hi', { margin: 0, ecl: 'L' })
    expect(tight).toContain('viewBox="0 0 21 21"')
    const robust = qrSvg(url, { ecl: 'H' })
    const big = Number(robust.match(/viewBox="0 0 (\d+)/)![1])
    expect(big).toBeGreaterThan(37)
  })

  it('draws rounded modules and finder eyes', () => {
    const svg = qrSvg(url, { style: 'rounded' })
    expect(svg).not.toContain('crispEdges')
    expect(svg).toMatch(/a0\.42 0\.42/)
    // Three eyes, three nested rounded rects each.
    expect(svg.match(/a2 2 0 0 1/g)?.length).toBe(3 * 4)
  })

  it('escapes the accessible label', () => {
    const svg = qrSvg('x', { label: 'Pair "your" <phone> & go' })
    expect(svg).toContain('aria-label="Pair &#34;your&#34; &#60;phone&#62; &#38; go"')
  })

  it('is deterministic', () => {
    expect(qrSvg(url)).toBe(qrSvg(url))
    expect(qrSvg(url)).not.toBe(qrSvg(`${url}X`))
  })
})
