import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAccountState, saveAccountState } from '../state-store.js';
import { applyBodyMassBatch, configureHealthKit } from '../healthkit/body-mass.js';

const BATCH_A = '10000000-0000-4000-8000-000000000001';
const BATCH_B = '10000000-0000-4000-8000-000000000002';
const SAMPLE_A = '20000000-0000-4000-8000-000000000001';
const SAMPLE_B = '20000000-0000-4000-8000-000000000002';

function useAccount(t, state = { unit: 'kg', bodyweight: [] }) {
  const previous = process.env.DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-healthkit-'));
  process.env.DATA_DIR = dataDir;
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
  saveAccountState('health-user', state);
  configureHealthKit('health-user', { enabled: true, timeZone: 'America/Los_Angeles' });
}

function batch({ batchId = BATCH_A, samples = [], deletedIds = [] } = {}) {
  return { schema: 1, batchId, samples, deletedIds };
}

function sample({ id = SAMPLE_A, start = '2026-09-07T16:30:00.000Z', kg = 80 } = {}) {
  return { id, start, kg };
}

test('duplicate batch replay is a no-op and does not increment the revision', t => {
  useAccount(t);
  const first = applyBodyMassBatch('health-user', batch({ samples: [sample()] }));
  const replay = applyBodyMassBatch('health-user', batch({ samples: [sample()] }));

  assert.equal(first.changed, true);
  assert.deepEqual(replay, { batchId: BATCH_A, revision: first.revision, changed: false });
});

test('a tombstone received before its sample prevents later projection', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ deletedIds: [SAMPLE_A] }));
  applyBodyMassBatch('health-user', batch({ batchId: BATCH_B, samples: [sample()] }));

  const { state } = readAccountState('health-user');
  assert.deepEqual(state.bodyweight, []);
  assert.equal(state._healthkit.deleted[SAMPLE_A], true);
});

test('deleting the newest winner reveals the prior measurement for that day', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [
    sample({ id: SAMPLE_A, start: '2026-09-07T15:00:00.000Z', kg: 80 }),
    sample({ id: SAMPLE_B, start: '2026-09-07T16:00:00.000Z', kg: 82 }),
  ] }));
  applyBodyMassBatch('health-user', batch({ batchId: BATCH_B, deletedIds: [SAMPLE_B] }));

  assert.deepEqual(readAccountState('health-user').state.bodyweight, [
    { d: '2026-09-07', w: 80, t: 1788793200000 },
  ]);
});

test('a manual legacy measurement has priority over a same-day HealthKit sample', t => {
  useAccount(t, { unit: 'kg', bodyweight: [{ d: '2026-09-07', w: 75, t: 123 }] });
  applyBodyMassBatch('health-user', batch({ samples: [sample()] }));

  assert.deepEqual(readAccountState('health-user').state.bodyweight, [
    { d: '2026-09-07', w: 75, t: 123 },
  ]);
});

test('deleting a manual override reveals its retained HealthKit source', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [sample()] }));
  let current = readAccountState('health-user');
  saveAccountState('health-user', {
    ...current.state,
    bodyweight: [{ d: '2026-09-07', w: 77, t: 999 }],
  }, current.revision);
  current = readAccountState('health-user');
  const revealed = saveAccountState('health-user', {
    ...current.state,
    bodyweight: [],
  }, current.revision);

  assert.deepEqual(revealed.state.bodyweight, [
    { d: '2026-09-07', w: 80, t: 1788798600000 },
  ]);
});

test('the same UUID with different content conflicts without partially applying the batch', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [sample()] }));
  const before = readAccountState('health-user');

  assert.throws(
    () => applyBodyMassBatch('health-user', batch({
      batchId: BATCH_B,
      samples: [
        sample({ id: SAMPLE_B, start: '2026-09-08T16:30:00.000Z', kg: 81 }),
        sample({ kg: 81 }),
      ],
    })),
    error => error?.code === 'sample_conflict',
  );
  assert.deepEqual(readAccountState('health-user'), before);
});

test('unit changes recompute projected display weight from canonical kg', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [sample()] }));
  const current = readAccountState('health-user');
  const saved = saveAccountState('health-user', {
    ...current.state,
    unit: 'lb',
    bodyweight: current.state.bodyweight.map(entry => ({ ...entry, w: 176.5 })),
  }, current.revision);

  assert.equal(saved.state.bodyweight[0].w, 176.4);
  assert.equal(saved.state._healthkit.samples[SAMPLE_A].kg, 80);
});

test('the configured timezone determines which side of local midnight receives a sample', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [
    sample({ id: SAMPLE_A, start: '2026-09-08T06:59:00.000Z', kg: 80 }),
    sample({ id: SAMPLE_B, start: '2026-09-08T07:01:00.000Z', kg: 81 }),
  ] }));

  assert.deepEqual(readAccountState('health-user').state.bodyweight, [
    { d: '2026-09-07', w: 80, t: 1788850740000 },
    { d: '2026-09-08', w: 81, t: 1788850860000 },
  ]);
});

test('initial enablement timezone remains fixed on later configuration calls', t => {
  useAccount(t);
  const current = readAccountState('health-user');
  const configured = configureHealthKit('health-user', { enabled: true, timeZone: 'Asia/Tokyo' });

  assert.equal(configured.timeZone, 'America/Los_Angeles');
  assert.equal(configured.revision, current.revision);
});

test('invalid timezone and invalid batches are rejected before state changes', t => {
  useAccount(t);
  const before = readAccountState('health-user');

  assert.throws(
    () => configureHealthKit('health-user', { enabled: true, timeZone: 'Mars/Olympus' }),
    error => error?.code === 'invalid_healthkit_config',
  );
  assert.throws(
    () => applyBodyMassBatch('health-user', batch({ samples: [
      sample({ id: SAMPLE_A }),
      sample({ id: 'not-a-uuid', kg: -1 }),
    ] })),
    error => error?.code === 'invalid_body_mass_batch',
  );
  assert.deepEqual(readAccountState('health-user'), before);
});

test('batch acknowledgement preserves the client batch ID exactly', t => {
  useAccount(t);
  const batchId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';

  assert.equal(applyBodyMassBatch('health-user', batch({ batchId })).batchId, batchId);
});

test('validation rejects non-UTC dates and values outside the documented limits', t => {
  useAccount(t);
  const before = readAccountState('health-user');
  const tooMany = Array.from({ length: 501 }, () => SAMPLE_A);
  const invalid = [
    batch({ samples: [sample({ start: '2026-09-07' })] }),
    batch({ samples: [sample({ start: '2026-02-30T12:00:00.000Z' })] }),
    batch({ samples: [sample({ kg: 0 })] }),
    batch({ samples: [sample({ kg: 1000.1 })] }),
    batch({ deletedIds: tooMany }),
  ];

  for (const value of invalid) {
    assert.throws(
      () => applyBodyMassBatch('health-user', value),
      error => error?.code === 'invalid_body_mass_batch',
    );
  }
  assert.deepEqual(readAccountState('health-user'), before);
});

test('UUID breaks a timestamp tie deterministically', t => {
  useAccount(t);
  applyBodyMassBatch('health-user', batch({ samples: [
    sample({ id: SAMPLE_A, kg: 80 }),
    sample({ id: SAMPLE_B, kg: 81 }),
  ] }));

  assert.equal(readAccountState('health-user').state.bodyweight[0].w, 81);
});

test('disabled HealthKit rejects a body-mass batch without changing state', t => {
  useAccount(t);
  configureHealthKit('health-user', { enabled: false });
  const before = readAccountState('health-user');

  assert.throws(
    () => applyBodyMassBatch('health-user', batch({ samples: [sample()] })),
    error => error?.code === 'healthkit_disabled' && error.revision === before.revision,
  );
  assert.deepEqual(readAccountState('health-user'), before);
});
