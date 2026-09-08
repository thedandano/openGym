import { readAccountState, updateAccountState } from '../state-store.js';

const HEALTHKIT_SCHEMA = 1;
const MAX_BATCH_RECORDS = 500;
const MAX_KG = 1000;
const LB_PER_KG = 2.2046226218;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function healthKitError(code, revision) {
  return Object.assign(new Error(code), { code, revision });
}

function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function canonicalSample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
  if (typeof sample.id !== 'string' || !UUID.test(sample.id)) return null;
  const timestamp = typeof sample.start === 'string' ? UTC_TIMESTAMP.exec(sample.start) : null;
  const milliseconds = timestamp ? Date.parse(sample.start) : NaN;
  if (!timestamp || !Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const actual = [
    date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ];
  if (actual.some((value, index) => value !== Number(timestamp[index + 1]))) return null;
  if (typeof sample.kg !== 'number' || !Number.isFinite(sample.kg) || sample.kg <= 0 || sample.kg > MAX_KG) return null;
  return { id: sample.id.toLowerCase(), start: date.toISOString(), kg: sample.kg };
}

function canonicalBatch(batch, revision) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || batch.schema !== HEALTHKIT_SCHEMA) {
    throw healthKitError('invalid_body_mass_batch', revision);
  }
  if (typeof batch.batchId !== 'string' || !UUID.test(batch.batchId)) {
    throw healthKitError('invalid_body_mass_batch', revision);
  }
  if (!Array.isArray(batch.samples) || !Array.isArray(batch.deletedIds)) {
    throw healthKitError('invalid_body_mass_batch', revision);
  }
  if (batch.samples.length + batch.deletedIds.length > MAX_BATCH_RECORDS) {
    throw healthKitError('invalid_body_mass_batch', revision);
  }

  const samples = [];
  const seen = new Map();
  for (const value of batch.samples) {
    const sample = canonicalSample(value);
    if (!sample) throw healthKitError('invalid_body_mass_batch', revision);
    const prior = seen.get(sample.id);
    if (prior && !isSameSample(prior, sample)) throw healthKitError('invalid_body_mass_batch', revision);
    if (!prior) {
      seen.set(sample.id, sample);
      samples.push(sample);
    }
  }
  const deletedIds = [];
  const deletedSeen = new Set();
  for (const value of batch.deletedIds) {
    if (typeof value !== 'string' || !UUID.test(value)) throw healthKitError('invalid_body_mass_batch', revision);
    const id = value.toLowerCase();
    if (!deletedSeen.has(id)) deletedIds.push(id);
    deletedSeen.add(id);
  }
  return { batchId: batch.batchId, samples, deletedIds };
}

function isSameSample(left, right) {
  return left.id === right.id && left.start === right.start && left.kg === right.kg;
}

function dayInTimeZone(start, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(start));
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function displayWeight(kg, unit) {
  const value = unit === 'lb' ? kg * LB_PER_KG : kg;
  return Math.round(value * 10) / 10;
}

function projectedByDay(state) {
  const health = state?._healthkit;
  const projected = new Map();
  if (!health || !validTimeZone(health.timeZone)) return projected;
  for (const sample of Object.values(health.samples || {})) {
    if (health.deleted?.[sample.id]) continue;
    const day = dayInTimeZone(sample.start, health.timeZone);
    const previous = projected.get(day);
    const timestamp = Date.parse(sample.start);
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && sample.id > previous.sample.id)) {
      projected.set(day, { sample, timestamp });
    }
  }
  return projected;
}

export function mergeBodyMassProjection(previousState, nextState) {
  const health = nextState?._healthkit;
  if (!health) return nextState;

  const oldProjection = projectedByDay(previousState);
  const manual = new Map();
  for (const entry of Array.isArray(nextState.bodyweight) ? nextState.bodyweight : []) {
    const old = oldProjection.get(entry?.d);
    if (old && entry?.t === old.timestamp) continue;
    if (entry?.d) manual.set(entry.d, entry);
  }
  for (const [day, winner] of projectedByDay(nextState)) {
    if (manual.has(day)) continue;
    manual.set(day, {
      d: day,
      w: displayWeight(winner.sample.kg, nextState.unit || 'kg'),
      t: winner.timestamp,
    });
  }
  nextState.bodyweight = [...manual.values()].sort((left, right) => left.d.localeCompare(right.d));
  return nextState;
}

export function configureHealthKit(uid, config) {
  const current = readAccountState(uid);
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.enabled !== 'boolean') {
    throw healthKitError('invalid_healthkit_config', current.revision);
  }
  if (config.timeZone !== undefined && !validTimeZone(config.timeZone)) {
    throw healthKitError('invalid_healthkit_config', current.revision);
  }
  const result = updateAccountState(uid, state => {
    const previous = state._healthkit;
    const wasEnabled = state._sync?.requireRevision === true;
    state._healthkit = {
      schema: HEALTHKIT_SCHEMA,
      enabled: config.enabled,
      timeZone: wasEnabled ? previous?.timeZone || 'UTC' : config.timeZone || previous?.timeZone || 'UTC',
      samples: previous?.samples || {},
      deleted: previous?.deleted || {},
    };
    state._sync = { ...(state._sync || {}), requireRevision: wasEnabled || config.enabled };
    return state;
  });
  return {
    enabled: result.state._healthkit.enabled,
    timeZone: result.state._healthkit.timeZone,
    revision: result.revision,
  };
}

export function applyBodyMassBatch(uid, batch) {
  const before = readAccountState(uid);
  const canonical = canonicalBatch(batch, before.revision);
  if (!before.state?._healthkit?.enabled) throw healthKitError('healthkit_disabled', before.revision);
  for (const sample of canonical.samples) {
    const previous = before.state._healthkit.samples?.[sample.id];
    if (previous && !isSameSample(previous, sample)) {
      throw healthKitError('sample_conflict', before.revision);
    }
  }

  let changed = false;
  const result = updateAccountState(uid, state => {
    const health = state._healthkit;
    const previousState = structuredClone(state);
    for (const sample of canonical.samples) {
      const previous = health.samples[sample.id];
      if (previous) continue;
      health.samples[sample.id] = structuredClone(sample);
      changed = true;
    }
    for (const id of canonical.deletedIds) {
      if (health.deleted[id]) continue;
      health.deleted[id] = true;
      changed = true;
    }
    if (!changed) return state;
    return mergeBodyMassProjection(previousState, state);
  });
  return { batchId: canonical.batchId, revision: result.revision, changed };
}
