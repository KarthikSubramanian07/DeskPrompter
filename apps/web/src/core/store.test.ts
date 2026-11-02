import { beforeEach, afterEach, expect, it, vi } from 'vitest'

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }))
import { get, set } from 'idb-keyval'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(set).mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

it('reports pending edits and only reports saved after storage finishes', async () => {
  const store = await import('./store')
  let finish!: () => void
  vi.mocked(set).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  store.newScript('Draft', 'First line')
  expect(store.saveStatus.value).toBe('saving')
  const pending = store.saveNow()
  await Promise.resolve()
  expect(store.saveStatus.value).toBe('saving')
  finish()
  await pending
  expect(store.saveStatus.value).toBe('saved')
})

it('keeps edits available after a failed save and allows retry', async () => {
  const store = await import('./store')
  vi.mocked(set).mockRejectedValueOnce(new Error('Quota exceeded'))
  store.newScript('Draft', 'Do not lose this')
  await store.saveNow()
  expect(store.saveStatus.value).toBe('error')
  expect(store.scripts.value[0]?.text).toBe('Do not lose this')
  await store.saveNow()
  expect(store.saveStatus.value).toBe('saved')
})

it('serializes writes and never marks newer edits saved by an older write', async () => {
  const store = await import('./store')
  let finish!: () => void
  vi.mocked(set).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const script = store.newScript('Draft', 'Old')
  const first = store.saveNow()
  await Promise.resolve()
  store.updateScript(script.id, { text: 'New' })
  const second = store.saveNow()
  expect(set).toHaveBeenCalledTimes(1)
  finish()
  await first
  expect(store.saveStatus.value).toBe('saving')
  await second
  expect(vi.mocked(set).mock.calls[1]?.[1][0].text).toBe('New')
  expect(store.saveStatus.value).toBe('saved')
})

it('surfaces storage read failures on startup', async () => {
  vi.mocked(get).mockRejectedValueOnce(new Error('Unavailable'))
  const store = await import('./store')
  await store.hydrate()
  expect(store.ready.value).toBe(true)
  expect(store.saveStatus.value).toBe('error')
})
