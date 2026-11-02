/**
 * QR codes rendered locally to an SVG string (no network, no canvas). Modules
 * use `currentColor`, so the code inherits text color from CSS.
 */

import qrcode from 'qrcode-generator'

export interface QrOptions {
  /** Module shape. `rounded` draws dot modules and soft finder eyes. */
  style?: 'square' | 'rounded'
  /** Quiet zone in modules. Scanners want some; 2 is a good compromise on screens. */
  margin?: number
  /** Error correction; `M` survives glare on a laptop screen. */
  ecl?: 'L' | 'M' | 'Q' | 'H'
  /** Accessible label; defaults to the encoded text. */
  label?: string
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const r2 = (n: number) => Math.round(n * 1000) / 1000

export function qrSvg(text: string, opts: QrOptions = {}): string {
  const { style = 'square', margin = 2, ecl = 'M', label = text } = opts
  const qr = qrcode(0, ecl)
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const size = n + margin * 2

  // Finder patterns: the three 7x7 eyes in the corners.
  const eyes = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ] as const
  const inEye = (r: number, c: number) => eyes.some(([er, ec]) => r >= er && r < er + 7 && c >= ec && c < ec + 7)

  let d = ''
  if (style === 'square') {
    // One path; merge horizontal runs to keep the markup small.
    for (let r = 0; r < n; r++) {
      let c = 0
      while (c < n) {
        if (!qr.isDark(r, c)) {
          c++
          continue
        }
        let end = c
        while (end < n && qr.isDark(r, end)) end++
        d += `M${c + margin} ${r + margin}h${end - c}v1h${c - end}z`
        c = end
      }
    }
  } else {
    const rad = 0.42
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (inEye(r, c) || !qr.isDark(r, c)) continue
        const cx = c + margin + 0.5
        const cy = r + margin + 0.5
        d += `M${r2(cx - rad)} ${cy}a${rad} ${rad} 0 1 0 ${r2(rad * 2)} 0a${rad} ${rad} 0 1 0 ${r2(-rad * 2)} 0z`
      }
    }
    for (const [er, ec] of eyes) {
      const x = ec + margin
      const y = er + margin
      // Outer ring (7x7, 1 thick) as an even-odd rounded frame, plus a 3x3 rounded pupil.
      d += roundRect(x, y, 7, 7, 2) + roundRect(x + 1, y + 1, 5, 5, 1.4) + roundRect(x + 2, y + 2, 3, 3, 0.9)
    }
  }

  const rendering = style === 'square' ? ' shape-rendering="crispEdges"' : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}"${rendering}>` +
    `<path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>`
  )
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y}h${r2(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${r2(h - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}` +
    `h${r2(-(w - 2 * r))}a${r} ${r} 0 0 1 ${-r} ${-r}v${r2(-(h - 2 * r))}a${r} ${r} 0 0 1 ${r} ${-r}z`
  )
}
