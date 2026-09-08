import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { mergeBodyMassProjection } from './healthkit/body-mass.js';

const SYNC_SCHEMA = 1;

const stateFile = uid => path.join(
  process.env.DATA_DIR || '/data',
  'state-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json',
);

export function atomicWrite(file, content, mode) {
  // ponytail: the API is a single writer today; add unique temp names and a cross-process lock
  // before running more than one API process against the same DATA_DIR.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function syncFor(state) {
  const sync = state?._sync;
  return {
    schema: SYNC_SCHEMA,
    revision: Number.isInteger(sync?.revision) && sync.revision >= 0 ? sync.revision : 0,
    requireRevision: sync?.requireRevision === true,
  };
}

function stateError(code, revision) {
  return Object.assign(new Error(code), { code, revision });
}

export function readAccountState(uid) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(uid), 'utf8'));
    return { state, revision: syncFor(state).revision };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: null, revision: 0 };
    throw new Error(`could not read account state for ${uid}: ${error.message}`, { cause: error });
  }
}

export function updateAccountState(uid, update) {
  const current = readAccountState(uid);
  const state = structuredClone(current.state || {});
  const next = update(state, current.revision);
  if (isDeepStrictEqual(next, current.state)) return current;

  const previousSync = syncFor(current.state);
  next._sync = {
    schema: SYNC_SCHEMA,
    revision: current.revision + 1,
    requireRevision: previousSync.requireRevision || next._sync?.requireRevision === true,
  };
  fs.mkdirSync(path.dirname(stateFile(uid)), { recursive: true });
  atomicWrite(stateFile(uid), JSON.stringify(next));
  return { state: next, revision: next._sync.revision };
}

export function saveAccountState(uid, state, baseRevision) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw stateError('state_required', 0);
  const current = readAccountState(uid);
  const sync = syncFor(current.state);
  if (sync.requireRevision && baseRevision === undefined) {
    throw stateError('client_update_required', current.revision);
  }
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    throw stateError('state_conflict', current.revision);
  }

  return updateAccountState(uid, next => {
    const incoming = structuredClone(state);
    delete incoming.active;
    delete incoming._healthkit;
    delete incoming._sync;
    if (next._healthkit) incoming._healthkit = next._healthkit;
    incoming._sync = sync;
    return mergeBodyMassProjection(next, incoming);
  });
}
