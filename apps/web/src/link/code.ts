/**
 * Room codes: six characters from an alphabet without look-alikes (no 0/O,
 * 1/I/L), so a code can be read off a laptop and typed on a phone. Must match
 * `ROOM_CODE_ALPHABET` in crates/relay/src/protocol.rs.
 */

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

type RandomFill = (buf: Uint8Array<ArrayBuffer>) => Uint8Array

const cryptoFill: RandomFill = (buf) => crypto.getRandomValues(buf)

/**
 * Uniformly random code via rejection sampling (31 symbols do not divide 256,
 * so a plain modulo would bias the first symbols).
 */
export function generateRoomCode(fill: RandomFill = cryptoFill): string {
  const n = ROOM_CODE_ALPHABET.length
  const limit = 256 - (256 % n)
  let out = ''
  while (out.length < ROOM_CODE_LENGTH) {
    for (const b of fill(new Uint8Array(16))) {
      if (b < limit) out += ROOM_CODE_ALPHABET[b % n]
      if (out.length === ROOM_CODE_LENGTH) break
    }
  }
  return out
}

/** Uppercases, strips spaces/dashes, and validates. Returns null when invalid. */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const code = raw.replace(/[\s-]/g, '').toUpperCase()
  if (code.length !== ROOM_CODE_LENGTH) return null
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null
  return code
}

export const isRoomCode = (raw: string): boolean => normalizeRoomCode(raw) === raw

/** The URL a phone opens (via QR) to become a remote for this room. */
export function pairUrl(code: string, origin: string = location.origin): string {
  return `${origin.replace(/\/$/, '')}/remote?c=${encodeURIComponent(code)}`
}

/** Display form, e.g. `K7P-Q2M`, easier to read aloud. */
export const formatRoomCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`

/** Random peer id for this tab (letters and digits, relay accepts 4..24). */
export function randomPeerId(fill: RandomFill = cryptoFill): string {
  const alpha = 'abcdefghijkmnpqrstuvwxyz23456789'
  return Array.from(fill(new Uint8Array(12)), (b) => alpha[b & 31]).join('')
}
