/**
 * Runtime validation for LinkMessages. Everything that arrives over a
 * BroadcastChannel, data channel or the relay is untrusted until it passes
 * `parseLinkMessage`, which returns a fresh object holding only known fields.
 */

import type { LinkMessage, LinkRole, PrompterMode, PrompterSnapshot, RemoteCommand } from '../core/contracts'

/** Generous cap for a script body; anything larger is refused rather than buffered. */
export const MAX_SCRIPT_CHARS = 1_000_000
const MAX_SHORT = 2_000

const SIMPLE_COMMANDS = new Set(['toggle', 'play', 'pause', 'faster', 'slower', 'back', 'forward', 'top', 'mirror'])
const VALUE_COMMANDS = new Set(['speed', 'seek', 'nudge'])
const ROLES = new Set<LinkRole>(['host', 'remote', 'display'])
const MODES = new Set<PrompterMode>(['manual', 'voice', 'breath'])

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown, max = MAX_SHORT): v is string => typeof v === 'string' && v.length <= max

export function isLinkRole(v: unknown): v is LinkRole {
  return typeof v === 'string' && ROLES.has(v as LinkRole)
}

export function parseRemoteCommand(v: unknown): RemoteCommand | null {
  if (!isObj(v) || typeof v.c !== 'string') return null
  if (SIMPLE_COMMANDS.has(v.c)) return { c: v.c as Extract<RemoteCommand, { c: 'toggle' }>['c'] }
  if (VALUE_COMMANDS.has(v.c) && isNum(v.v)) return { c: v.c as 'speed' | 'seek' | 'nudge', v: v.v }
  return null
}

export function parseSnapshot(v: unknown): PrompterSnapshot | null {
  if (!isObj(v)) return null
  const { playing, speed, progress, elapsedMs, remainingMs, wpm, mode, mirrorX, mirrorY, title, currentLine } = v
  if (typeof playing !== 'boolean' || typeof mirrorX !== 'boolean' || typeof mirrorY !== 'boolean') return null
  if (!isNum(speed) || !isNum(progress) || !isNum(elapsedMs) || !isNum(remainingMs) || !isNum(wpm)) return null
  if (typeof mode !== 'string' || !MODES.has(mode as PrompterMode)) return null
  if (!isStr(title) || !isStr(currentLine)) return null
  return {
    playing,
    speed,
    progress: Math.min(1, Math.max(0, progress)),
    elapsedMs: Math.max(0, elapsedMs),
    remainingMs: Math.max(0, remainingMs),
    wpm,
    mode: mode as PrompterMode,
    mirrorX,
    mirrorY,
    title,
    currentLine,
  }
}

/** Validates an unknown value as a LinkMessage. Returns null for anything malformed. */
export function parseLinkMessage(v: unknown): LinkMessage | null {
  if (!isObj(v)) return null
  switch (v.t) {
    case 'cmd': {
      const cmd = parseRemoteCommand(v)
      return cmd ? { t: 'cmd', ...cmd } : null
    }
    case 'state': {
      const s = parseSnapshot(v.s)
      return s ? { t: 'state', s } : null
    }
    case 'hello': {
      if (!isLinkRole(v.role)) return null
      if (v.name !== undefined && !isStr(v.name, 200)) return null
      return v.name === undefined ? { t: 'hello', role: v.role } : { t: 'hello', role: v.role, name: v.name as string }
    }
    case 'script':
      return isStr(v.title) && isStr(v.text, MAX_SCRIPT_CHARS) ? { t: 'script', title: v.title, text: v.text } : null
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

/** Parses a JSON string and validates it. */
export function decodeLinkMessage(text: string): LinkMessage | null {
  try {
    return parseLinkMessage(JSON.parse(text))
  } catch {
    return null
  }
}

export function encodeLinkMessage(msg: LinkMessage): string {
  return JSON.stringify(msg)
}
