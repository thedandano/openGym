// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn() }))
vi.mock('../lib/remote.js', () => ({ connect: vi.fn(), loadRemote: vi.fn(), chooseLocal: vi.fn(), forgetRemote: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios' }, registerPlugin: () => ({ latestBodyMass: nativeRead }) }))
const { nativeRead } = vi.hoisted(() => ({ nativeRead: vi.fn() }))

import { api } from '../lib/api.js'
import { connect } from '../lib/remote.js'
import { DEF, useStore } from './useStore.js'

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  nativeRead.mockReset()
  api.mockReset().mockResolvedValue({})
  useStore.setState({ S: structuredClone(DEF), ready: true })
  useStore.getState().setUser({ id: 'one' })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('does not import in local-only mode before pairing with an older populated account', async () => {
  useStore.getState().setUser(null)
  useStore.getState().setGuest(true)
  nativeRead.mockResolvedValue({ status: 'available', kilograms: 80, measuredAt: Date.now() })
  await useStore.getState().syncHealthWeight()
  expect.soft(nativeRead).not.toHaveBeenCalled()
  expect.soft(useStore.getState().S.bodyweight).toEqual([])
  expect.soft(localStorage.getItem('gym_state_v1')).toBeNull()

  const remote = { ...structuredClone(DEF), _ts: 1, workouts: [{ id: 'saved-workout', entries: [] }], routines: [{ id: 'saved-routine', ex: [] }] }
  connect.mockResolvedValue({ id: 'paired-user' })
  api.mockImplementation(path => Promise.resolve(path === '/api/data' ? { state: remote } : {}))
  await useStore.getState().connectToServer('https://gym.example', 'code')
  expect(useStore.getState().S.workouts).toEqual(remote.workouts)
  expect(useStore.getState().S.routines).toEqual(remote.routines)
  expect(api.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
})

it('saves the latest Apple weight in the profile unit through existing persistence and push', async () => {
  const measuredAt = new Date(2026, 8, 8, 7).getTime()
  useStore.setState({ S: { ...structuredClone(DEF), unit: 'lb', bodyweight: [{ d: '2026-09-01', w: 170, t: 1 }], active: { bw: 160 } } })
  nativeRead.mockResolvedValue({ status: 'available', kilograms: 80, measuredAt })
  await useStore.getState().syncHealthWeight()
  expect(useStore.getState().S.bodyweight).toEqual([{ d: '2026-09-01', w: 170, t: 1 }, { d: '2026-09-08', w: 176.4, t: measuredAt }])
  expect(useStore.getState().S.active.bw).toBe(160)
  expect(JSON.parse(localStorage.getItem('gym_state_v1')).bodyweight).toEqual(useStore.getState().S.bodyweight)
  await vi.advanceTimersByTimeAsync(1500)
  expect(api).toHaveBeenCalledWith('/api/data', expect.objectContaining({ method: 'PUT' }))
  expect(useStore.getState().healthWeightStatus).toBe('available')
})

it('replaying a sample does not persist or schedule another push', async () => {
  nativeRead.mockResolvedValue({ status: 'available', kilograms: 80, measuredAt: new Date(2026, 8, 8, 7).getTime() })
  await useStore.getState().syncHealthWeight()
  await vi.advanceTimersByTimeAsync(1500)
  const saved = useStore.getState().S
  api.mockClear()
  await useStore.getState().syncHealthWeight()
  await vi.advanceTimersByTimeAsync(1500)
  expect(useStore.getState().S).toBe(saved)
  expect(api).not.toHaveBeenCalled()
})

it('keeps a newer manual same-day entry when Health returns an older sample', async () => {
  const manual = { d: '2026-09-08', w: 82, t: new Date(2026, 8, 8, 12).getTime() }
  useStore.setState({ S: { ...structuredClone(DEF), bodyweight: [manual] } })
  nativeRead.mockResolvedValue({ status: 'available', kilograms: 80, measuredAt: new Date(2026, 8, 8, 7).getTime() })
  await useStore.getState().syncHealthWeight()
  expect(useStore.getState().S.bodyweight).toEqual([manual])
  expect(localStorage.getItem('gym_state_v1')).toBeNull()
})

it('waits for restore before reading Health', async () => {
  useStore.setState({ ready: false })
  await useStore.getState().syncHealthWeight()
  expect(nativeRead).not.toHaveBeenCalled()
  expect(useStore.getState().S.bodyweight).toEqual([])
})

it('coalesces foreground reads and discards a result after sign-out', async () => {
  let finish
  nativeRead.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = useStore.getState().syncHealthWeight()
  const second = useStore.getState().syncHealthWeight()
  expect(nativeRead).toHaveBeenCalledTimes(1)
  useStore.getState().setUser(null)
  finish({ status: 'available', kilograms: 80, measuredAt: Date.now() })
  await Promise.all([first, second])
  expect(useStore.getState().S.bodyweight).toEqual([])
  expect(useStore.getState().healthWeightStatus).toBe('pending')
})

it.each([
  { status: 'unsupported' },
  { status: 'no-readable-data' },
  { status: 'available', kilograms: -1, measuredAt: Date.now() },
  { status: 'available', kilograms: 80, measuredAt: 'bad-date' },
])('keeps manual fallback and history for $status without a usable sample', async sample => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  nativeRead.mockResolvedValue(sample)
  await useStore.getState().syncHealthWeight()
  expect(useStore.getState().S.bodyweight).toEqual([])
  expect(useStore.getState().healthWeightStatus).not.toBe('available')
  expect(warning).toHaveBeenCalled()
  warning.mockRestore()
})

it('reports native failure and leaves manual fallback usable', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  nativeRead.mockRejectedValue(new Error('Read failed'))
  await useStore.getState().syncHealthWeight()
  expect(useStore.getState().healthWeightStatus).toBe('failed')
  expect(useStore.getState().S.bodyweight).toEqual([])
  expect(warning).toHaveBeenCalled()
  warning.mockRestore()
})

it('waits for paired account restore before allowing an import', async () => {
  let restore
  connect.mockResolvedValue({ id: 'two' })
  api.mockImplementation(path => path === '/api/data' ? new Promise(resolve => { restore = resolve }) : Promise.resolve({}))
  const pairing = useStore.getState().connectToServer('https://gym.example', 'code')
  await vi.waitFor(() => expect(restore).toBeTypeOf('function'))
  expect(useStore.getState().ready).toBe(false)
  await useStore.getState().syncHealthWeight()
  expect(nativeRead).not.toHaveBeenCalled()
  restore({ state: { bodyweight: [{ d: '2026-09-01', w: 70, t: 1 }] } })
  await pairing
  expect(useStore.getState().ready).toBe(true)
  expect(useStore.getState().S.bodyweight).toEqual([{ d: '2026-09-01', w: 70, t: 1 }])
})

it('discards an old account read as soon as pairing begins', async () => {
  let finishRead, finishPair
  nativeRead.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
  connect.mockImplementation(() => new Promise(resolve => { finishPair = resolve }))
  const reading = useStore.getState().syncHealthWeight()
  const pairing = useStore.getState().connectToServer('https://gym.example', 'code')
  finishRead({ status: 'available', kilograms: 80, measuredAt: Date.now() })
  await reading
  expect(useStore.getState().S.bodyweight).toEqual([])
  expect(useStore.getState().ready).toBe(false)
  api.mockResolvedValue({ state: null })
  finishPair({ id: 'two' })
  await pairing
})

it.each(['signOut', 'signOutAll'])('discards an in-flight read when %s begins', async method => {
  let finishRead, finishLogout
  nativeRead.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
  api.mockImplementation(path => path.startsWith('/api/logout') ? new Promise(resolve => { finishLogout = resolve }) : Promise.resolve({}))
  const reading = useStore.getState().syncHealthWeight()
  const logout = useStore.getState()[method]()
  await vi.waitFor(() => expect(finishLogout).toBeTypeOf('function'))
  finishRead({ status: 'available', kilograms: 80, measuredAt: Date.now() })
  await reading
  expect(useStore.getState().S.bodyweight).toEqual([])
  await useStore.getState().syncHealthWeight()
  expect(nativeRead).toHaveBeenCalledTimes(1)
  finishLogout({})
  await logout
  expect(useStore.getState().user).toBeNull()
})
