// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import * as healthkit from './healthkit.js'

const { addListener, remove } = vi.hoisted(() => ({ addListener: vi.fn(), remove: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/app', () => ({ App: { addListener } }))
afterEach(() => vi.clearAllMocks())

it('reads at startup and foreground, then removes listeners when the account view ends', async () => {
  let onState
  addListener.mockImplementation(async (event, callback) => { onState = callback; return { remove } })
  const read = vi.fn()
  const stop = healthkit.initHealthWeightSync(read)
  expect(read).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  onState({ isActive: false })
  expect(read).toHaveBeenCalledTimes(1)
  onState({ isActive: true })
  expect(read).toHaveBeenCalledTimes(2)
  stop()
  expect(remove).toHaveBeenCalledTimes(1)
})
