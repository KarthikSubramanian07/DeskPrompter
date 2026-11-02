import { describe, expect, it } from 'vitest'
import { ROOM_CODE_ALPHABET, formatRoomCode, generateRoomCode, isRoomCode, normalizeRoomCode, pairUrl, randomPeerId } from './code'

describe('room codes', () => {
  it('uses an alphabet without look-alikes that matches the relay', () => {
    expect(ROOM_CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789')
    for (const c of '01OIL') expect(ROOM_CODE_ALPHABET).not.toContain(c)
  })

  it('generates valid six character codes', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode()
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/)
      expect(isRoomCode(code)).toBe(true)
    }
  })

  it('is unbiased: rejects bytes above the largest multiple of 31', () => {
    // 248..255 must be skipped; 0 maps to 'A', 31 to 'A', 30 to '9'.
    const bytes = [255, 250, 248, 0, 31, 30, 62, 1, 2]
    const code = generateRoomCode((buf) => {
      buf.fill(0)
      bytes.forEach((b, i) => (buf[i] = b))
      return buf
    })
    expect(code).toBe('AA9ABC')
  })

  it('spreads across the whole alphabet', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) for (const c of generateRoomCode()) seen.add(c)
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length)
  })

  it('normalizes user input', () => {
    expect(normalizeRoomCode('k7p-q2m')).toBe('K7PQ2M')
    expect(normalizeRoomCode(' K7P Q2M ')).toBe('K7PQ2M')
    expect(normalizeRoomCode('K7PQ2')).toBeNull()
    expect(normalizeRoomCode('K7PQ20')).toBeNull()
    expect(normalizeRoomCode('K7PQ2I')).toBeNull()
    expect(normalizeRoomCode(null)).toBeNull()
    expect(isRoomCode('k7pq2m')).toBe(false)
  })

  it('formats for reading aloud', () => {
    expect(formatRoomCode('K7PQ2M')).toBe('K7P-Q2M')
  })

  it('builds the pairing URL', () => {
    expect(pairUrl('K7PQ2M', 'https://deskprompter.pages.dev')).toBe('https://deskprompter.pages.dev/remote?c=K7PQ2M')
    expect(pairUrl('K7PQ2M', 'http://localhost:5173/')).toBe('http://localhost:5173/remote?c=K7PQ2M')
    expect(pairUrl('K7PQ2M')).toBe(`${location.origin}/remote?c=K7PQ2M`)
  })

  it('makes relay-valid peer ids', () => {
    const id = randomPeerId()
    expect(id).toMatch(/^[a-z0-9]{12}$/)
    expect(randomPeerId()).not.toBe(id)
  })
})
