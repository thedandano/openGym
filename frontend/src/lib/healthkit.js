import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { isoOf } from './format.js'

const HealthKit = registerPlugin('HealthKit')
const POUNDS_PER_KILOGRAM = 2.2046226218

export const isHealthKitPlatform = () => Capacitor.getPlatform() === 'ios'
export const readHealthWeight = () => isHealthKitPlatform() ? HealthKit.latestBodyMass() : Promise.resolve({ status: 'unsupported' })

export function healthWeightEntry(sample, unit) {
  if (!Number.isFinite(sample.kilograms) || sample.kilograms <= 0 ||
      !Number.isFinite(sample.measuredAt) || !Number.isFinite(new Date(sample.measuredAt).getTime())) {
    throw new Error('Apple Health returned an invalid weight or date')
  }
  const weight = Math.round(sample.kilograms * (unit === 'lb' ? POUNDS_PER_KILOGRAM : 1) * 10) / 10
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('Apple Health returned an unusable weight')
  return {
    d: isoOf(new Date(sample.measuredAt)),
    w: weight,
    t: sample.measuredAt,
  }
}

// The existing manual daily entry format and update path, shared with Apple Health.
export function saveDailyWeight(state, entry) {
  const existing = state.bodyweight.find(b => b.d === entry.d)
  if (existing) Object.assign(existing, entry)
  else state.bodyweight.push(entry)
  state.bodyweight.sort((a, b) => a.d.localeCompare(b.d))
}

export function initHealthWeightSync(sync) {
  if (!isHealthKitPlatform()) return () => {}
  let stopped = false
  let listener = null
  const onVisible = () => { if (!stopped && document.visibilityState === 'visible') sync() }
  document.addEventListener('visibilitychange', onVisible)
  App.addListener('appStateChange', ({ isActive }) => { if (!stopped && isActive) sync() })
    .then(handle => { if (stopped) return handle.remove(); listener = handle })
    .catch(error => console.warn('Apple Health foreground listener failed; using page visibility events', error))
  sync()
  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', onVisible)
    if (listener) Promise.resolve(listener.remove()).catch(error => console.warn('Apple Health listener cleanup failed', error))
  }
}
