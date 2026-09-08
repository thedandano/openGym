// @vitest-environment happy-dom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { startFlow } from './sheets.jsx'

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({ S: { ...structuredClone(DEF), bodyweight: [{ d: '2026-09-08', w: 80, t: 1 }] }, user: { id: 'paired-user' }, healthWeightStatus: 'pending' })
  useUI.setState({ sheets: [], toasts: [] })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('uses the original manual sheet in local-only mode without claiming Health is pending', () => {
  useStore.setState({ user: null })
  startFlow(null)
  const sheet = useUI.getState().sheets.at(-1)
  expect(sheet.locked).toBe(true)
  expect(renderToStaticMarkup(sheet.render(() => {}))).not.toContain('Apple Health')
  expect(useStore.getState().S.active).toBeNull()
})

it('starts immediately with cached latest weight after successful Health sync', () => {
  useStore.setState({ healthWeightStatus: 'available' })
  startFlow(null)
  expect(useStore.getState().S.active.bw).toBe(80)
  expect(useUI.getState().sheets).toHaveLength(0)
})

it.each(['unsupported', 'no-readable-data', 'pending', 'failed'])('keeps the locked manual sheet and a visible reason when Health is %s', status => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useStore.setState({ healthWeightStatus: status })
  startFlow(null)
  const sheet = useUI.getState().sheets.at(-1)
  expect(sheet.locked).toBe(true)
  const html = renderToStaticMarkup(sheet.render(() => {}))
  expect(html).toContain('Apple Health')
  expect(html).toContain('Save &amp; start workout')
  expect(useStore.getState().S.active).toBeNull()
  expect(warning).toHaveBeenCalled()
  warning.mockRestore()
})

it('keeps manual entry when the cached history was deleted after Health sync', () => {
  useStore.setState({ healthWeightStatus: 'available', S: structuredClone(DEF) })
  startFlow(null)
  expect(useUI.getState().sheets.at(-1).locked).toBe(true)
  expect(useStore.getState().S.active).toBeNull()
})
