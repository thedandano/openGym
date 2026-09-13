// @vitest-environment happy-dom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'

const { nativeRead } = vi.hoisted(() => ({ nativeRead: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('../lib/remote.js', () => ({ loadRemote: vi.fn(), forgetRemote: vi.fn(), connect: vi.fn(), chooseLocal: vi.fn() }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: true, initReminderSync: vi.fn(), nativeLoad: vi.fn(), nativeSave: vi.fn(), onAppActive: vi.fn(), syncReminder: vi.fn(), writeAutoBackup: vi.fn() }))
vi.mock('../lib/coach-device.js', () => ({ loadCoachDevice: vi.fn(), saveCoachDevice: vi.fn(), coachDeviceSettings: () => null }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios' }, registerPlugin: () => ({ latestBodyMass: nativeRead }) }))

import { api } from '../lib/api.js'
import { loadRemote, forgetRemote } from '../lib/remote.js'
import { DEF, useStore } from './useStore.js'
import { useUI } from './useUI.js'
import { startFlow } from '../sheets.jsx'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); localStorage.clear() })

it('clears a revoked paired user before local mode can read Health or start a workout', async () => {
  vi.useFakeTimers()
  localStorage.clear()
  useStore.setState({ S: structuredClone(DEF), ready: false })
  useStore.getState().setUser({ id: 'previous-user' })
  useUI.setState({ sheets: [], toasts: [] })
  loadRemote.mockResolvedValue({ mode: 'remote', base: 'https://gym.example', token: 'revoked', user: { id: 'previous-user' } })
  api.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }))
  nativeRead.mockResolvedValue({ status: 'available', kilograms: 80, measuredAt: Date.now() })

  await useStore.getState().boot()
  expect.soft(useStore.getState().user).toBeNull()
  expect.soft(localStorage.getItem('gym_user')).toBeNull()
  expect(useStore.getState().isGuest()).toBe(true)
  expect(forgetRemote).toHaveBeenCalledTimes(1)
  await useStore.getState().syncHealthWeight()
  expect.soft(nativeRead).not.toHaveBeenCalled()
  expect.soft(useStore.getState().S.bodyweight).toEqual([])
  startFlow(null)
  const sheet = useUI.getState().sheets.at(-1)
  expect(sheet).toBeDefined()
  expect(sheet.locked).toBe(true)
  expect(renderToStaticMarkup(sheet.render(() => {}))).not.toContain('Apple Health')
  expect(useStore.getState().S.active).toBeNull()
})
