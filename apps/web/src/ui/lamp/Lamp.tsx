/**
 * Andon (行灯): DeskPrompter's lamp. A full-bleed SVG overlay holding the lamp
 * and the light it throws. Parents steer it through a mutable handle so the
 * animation loop never re-renders Preact.
 */
import { useEffect, useRef } from 'preact/hooks'
import { forward, GEO, LampRig, type Mood } from './rig'
import './lamp.css'

export interface LampHandle {
  rig: LampRig
  /** Where the base sits, in overlay pixels, and how big the lamp is. */
  anchor: { x: number; y: number; scale: number }
  /** Where the light lands (overlay pixels). Also what the lamp looks at unless `look` is set. */
  pool: { x: number; y: number; w: number; h: number }
  /** Optional separate gaze target (overlay pixels). */
  look: { x: number; y: number } | null
  beam: boolean
  /** Latest computed mouth position (overlay pixels), for anything that wants to follow the light. */
  mouth: { x: number; y: number }
  /** Hang upside down from the anchor (a clamp lamp on a shelf above). */
  hang: boolean
  /** Beam strength multiplier (0..1). */
  beamStrength: number
}

export function createLampHandle(init?: Partial<LampHandle>): LampHandle {
  return {
    rig: new LampRig(),
    anchor: { x: 120, y: 400, scale: 1 },
    pool: { x: 600, y: 300, w: 520, h: 120 },
    look: null,
    beam: true,
    mouth: { x: 0, y: 0 },
    hang: false,
    beamStrength: 1,
    ...init,
  }
}

const DEG = 180 / Math.PI

interface Props {
  handle: LampHandle
  class?: string
  /** Ignore pointer input entirely when false. */
  mood?: Mood
}

let uidCounter = 0

export function Lamp({ handle, class: cls }: Props) {
  const ids = useRef(`lamp${++uidCounter}`).current
  const root = useRef<SVGGElement>(null)
  const body = useRef<SVGGElement>(null)
  const lower = useRef<SVGGElement>(null)
  const upper = useRef<SVGGElement>(null)
  const head = useRef<SVGGElement>(null)
  const tag = useRef<SVGGElement>(null)
  const bulb = useRef<SVGCircleElement>(null)
  const rim = useRef<SVGEllipseElement>(null)
  const halo = useRef<SVGCircleElement>(null)
  const cone = useRef<SVGPathElement>(null)
  const coneGrad = useRef<SVGLinearGradientElement>(null)
  const pool = useRef<SVGEllipseElement>(null)
  const light = useRef<SVGGElement>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { anchor: a, rig } = handle
      const gaze = handle.look ?? handle.pool
      const fy = handle.hang ? -1 : 1
      rig.target = { x: (gaze.x - a.x) / a.scale, y: ((gaze.y - a.y) / a.scale) * fy }
      const p = rig.step(dt)
      const sx = a.scale * p.facing
      root.current?.setAttribute('transform', `translate(${a.x} ${a.y}) scale(${a.scale} ${a.scale * fy})`)
      body.current?.setAttribute('transform', `translate(0 ${p.lift}) scale(${p.facing} ${p.squash})`)
      lower.current?.setAttribute('transform', `translate(0 ${GEO.shoulderY}) rotate(${p.a1 * DEG})`)
      upper.current?.setAttribute('transform', `translate(0 ${-GEO.l1}) rotate(${p.a2 * DEG})`)
      head.current?.setAttribute('transform', `translate(0 ${-GEO.l2}) rotate(${(p.h - p.a1 - p.a2) * DEG})`)
      tag.current?.setAttribute('transform', `translate(9 -6) rotate(${(-p.h + p.tag + (handle.hang ? Math.PI : 0)) * DEG})`)
      const g = Math.max(0, p.glow)
      bulb.current?.setAttribute('opacity', String(0.25 + g * 0.75))
      rim.current?.setAttribute('opacity', String(0.15 + g * 0.85))
      halo.current?.setAttribute('opacity', String(g * 0.9))

      // World-space light.
      const fk = forward(p)
      const wx = (x: number) => a.x + x * sx
      const wy = (y: number) => a.y + (y * p.squash + p.lift) * a.scale * fy
      const mx = wx(fk.mouth.x)
      const my = wy(fk.mouth.y)
      handle.mouth.x = mx
      handle.mouth.y = my
      if (light.current) light.current.style.opacity = handle.beam ? String(Math.min(1, g) * handle.beamStrength) : '0'
      if (handle.beam && cone.current && pool.current && coneGrad.current) {
        // Mouth edges, perpendicular to the head direction.
        const px = -fk.dir.y
        const py = fk.dir.x
        const m = GEO.mouth * 0.92
        const l = { x: wx(fk.mouth.x + px * m), y: wy(fk.mouth.y + py * m) }
        const r = { x: wx(fk.mouth.x - px * m), y: wy(fk.mouth.y - py * m) }
        const P = handle.pool
        const hw = P.w / 2
        // Pick pool edges so the cone never crosses itself.
        const left = l.x < r.x ? l : r
        const right = l.x < r.x ? r : l
        cone.current.setAttribute(
          'd',
          `M${left.x},${left.y} L${P.x - hw},${P.y} Q${P.x},${P.y + P.h * 0.62} ${P.x + hw},${P.y} L${right.x},${right.y} Z`,
        )
        coneGrad.current.setAttribute('x1', String(mx))
        coneGrad.current.setAttribute('y1', String(my))
        coneGrad.current.setAttribute('x2', String(P.x))
        coneGrad.current.setAttribute('y2', String(P.y))
        pool.current.setAttribute('cx', String(P.x))
        pool.current.setAttribute('cy', String(P.y))
        pool.current.setAttribute('rx', String(hw * 1.05))
        pool.current.setAttribute('ry', String(P.h / 2))
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [handle])

  return (
    <svg class={`lamp-overlay ${cls ?? ''}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${ids}-brass`} x1="0" x2="1">
          <stop offset="0" stop-color="#6e5130" />
          <stop offset="0.45" stop-color="#d6a965" />
          <stop offset="1" stop-color="#7d5c33" />
        </linearGradient>
        <linearGradient id={`${ids}-shade`} x1="0" x2="1">
          <stop offset="0" stop-color="#8f3320" />
          <stop offset="0.38" stop-color="#e2694c" />
          <stop offset="0.62" stop-color="#d4553a" />
          <stop offset="1" stop-color="#7e2c1b" />
        </linearGradient>
        <linearGradient id={`${ids}-base`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3a342d" />
          <stop offset="1" stop-color="#16130f" />
        </linearGradient>
        <radialGradient id={`${ids}-bulb`}>
          <stop offset="0" stop-color="#fff6e0" />
          <stop offset="0.5" stop-color="#ffd690" />
          <stop offset="1" stop-color="#e8b26a" stop-opacity="0" />
        </radialGradient>
        <linearGradient ref={coneGrad} id={`${ids}-cone`} gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ffd8a0" stop-opacity="0.34" />
          <stop offset="0.7" stop-color="#e8b26a" stop-opacity="0.09" />
          <stop offset="1" stop-color="#e8b26a" stop-opacity="0.05" />
        </linearGradient>
        <radialGradient id={`${ids}-pool`}>
          <stop offset="0" stop-color="#ffcf8a" stop-opacity="0.22" />
          <stop offset="0.6" stop-color="#e8a85a" stop-opacity="0.08" />
          <stop offset="1" stop-color="#e8a85a" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${ids}-shadow`}>
          <stop offset="0" stop-color="#000" stop-opacity="0.55" />
          <stop offset="1" stop-color="#000" stop-opacity="0" />
        </radialGradient>
      </defs>

      <g ref={light} class="lamp-light">
        <path ref={cone} fill={`url(#${ids}-cone)`} />
        <ellipse ref={pool} fill={`url(#${ids}-pool)`} />
      </g>

      <g ref={root}>
        <ellipse cx="0" cy="3" rx="78" ry="9" fill={`url(#${ids}-shadow)`} />
        <g ref={body}>
          {/* base: a lacquered dome with a brass rim and a vermilion seal for a switch */}
          <path d="M-54,0 C-54,-11 -36,-18 0,-18 C36,-18 54,-11 54,0 Z" fill={`url(#${ids}-base)`} />
          <path d="M-54,0 L54,0" stroke="#b88a4a" stroke-width="2.2" stroke-linecap="round" />
          <path d="M-44,-9 C-30,-15 -12,-16.5 4,-16.6" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2" fill="none" />
          <rect x="20" y="-10.5" width="9" height="7.5" rx="1.2" fill="#d4553a" />
          <circle cx="0" cy={GEO.shoulderY} r="7.5" fill={`url(#${ids}-brass)`} />

          <g ref={lower}>
            <path d={`M-4.5,0 L-4.5,${-GEO.l1} M4.5,0 L4.5,${-GEO.l1}`} stroke={`url(#${ids}-brass)`} stroke-width="3.2" stroke-linecap="round" />
            <path d={coil(-16, -82, 13)} stroke="#a77d43" stroke-width="1.3" fill="none" />
            <circle cx="0" cy="0" r="3" fill="#2a241d" />
            <g ref={upper}>
              <circle cx="0" cy="0" r="7" fill={`url(#${ids}-brass)`} />
              <circle cx="0" cy="0" r="2.6" fill="#2a241d" />
              <path d={`M-3.5,-6 L-3.5,${-GEO.l2} M3.5,-6 L3.5,${-GEO.l2}`} stroke={`url(#${ids}-brass)`} stroke-width="2.8" stroke-linecap="round" />
              <path d={coil(-18, -70, 10)} stroke="#a77d43" stroke-width="1.1" fill="none" />
              <g ref={head}>
                <circle cx="0" cy="0" r="6.5" fill={`url(#${ids}-brass)`} />
                <rect x="-6" y="-14" width="12" height="11" rx="2.5" fill="#2a241d" />
                {/* the shade: a lacquered bell */}
                <path d="M-10,-10 C-13,-28 -28,-44 -35,-62 L35,-62 C28,-44 13,-28 10,-10 Z" fill={`url(#${ids}-shade)`} />
                <path d="M-6,-14 C-9,-28 -20,-42 -26,-56" stroke="#ffb59a" stroke-opacity="0.35" stroke-width="2" fill="none" stroke-linecap="round" />
                <ellipse ref={rim} cx="0" cy="-62" rx="35" ry="6.5" fill="#ffe2b0" />
                <circle ref={halo} cx="0" cy="-66" r="46" fill={`url(#${ids}-bulb)`} />
                <circle ref={bulb} cx="0" cy="-60" r="9.5" fill="#fff4dc" />
                <g ref={tag}>
                  <path d="M0,0 L0,22" stroke="#cdbf9e" stroke-width="0.9" />
                  <rect x="-7" y="22" width="14" height="19" rx="1.5" fill="#ece6d9" />
                  <text x="0" y="36" text-anchor="middle" class="lamp-tag">灯</text>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}

/** A little zig-zag spring between y0 and y1 (y0 > y1, both negative). */
function coil(y0: number, y1: number, turns: number): string {
  const step = (y1 - y0) / (turns * 2)
  let d = `M0,${y0}`
  for (let i = 1; i <= turns * 2; i++) d += ` L${i % 2 ? 4.2 : -4.2},${y0 + step * i}`
  return d + ` L0,${y1}`
}
