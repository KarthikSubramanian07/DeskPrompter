import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('first-visit guide', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })
  it('shows on a first visit and stays dismissed after that', async () => {
    const first = await import('./guide')
    expect(first.guideDone.value).toBe(false)
    first.dismissGuide()
    expect(first.guideDone.value).toBe(true)
    vi.resetModules()
    const again = await import('./guide')
    expect(again.guideDone.value).toBe(true)
  })
})
