import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { readAccountState, saveAccountState } from '../state-store.js';
import { applyBodyMassBatch, configureHealthKit } from '../healthkit/body-mass.js';

function useTemporaryDataDir(t, prefix = 'opengym-state-store-') {
  const previous = process.env.DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dataDir;
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
  return dataDir;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startApi(t, dataDir) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      ORIGIN: `http://127.0.0.1:${port}`,
      RP_ID: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API did not start within 5 seconds')), 5000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('gym-api on')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`API exited before startup with code ${code}`));
    });
  });
  return `http://127.0.0.1:${port}`;
}

test('a stale generic save cannot erase a HealthKit body-mass projection', t => {
  useTemporaryDataDir(t);

  const original = { unit: 'kg', bodyweight: [], routines: [] };
  const initial = saveAccountState('stale-user', original);
  configureHealthKit('stale-user', { enabled: true, timeZone: 'America/Los_Angeles' });
  applyBodyMassBatch('stale-user', {
    schema: 1,
    batchId: '10000000-0000-4000-8000-000000000001',
    samples: [{
      id: '20000000-0000-4000-8000-000000000001',
      start: '2026-09-07T16:30:00.000Z',
      kg: 80,
    }],
    deletedIds: [],
  });

  assert.throws(
    () => saveAccountState('stale-user', original, initial.revision),
    error => error?.code === 'state_conflict',
  );
  assert.deepEqual(readAccountState('stale-user').state.bodyweight, [
    { d: '2026-09-07', w: 80, t: 1788798600000 },
  ]);
});

test('legacy state migrates on save and still accepts a missing base revision', t => {
  const dataDir = useTemporaryDataDir(t);
  fs.writeFileSync(
    path.join(dataDir, 'state-legacy-user.json'),
    JSON.stringify({ unit: 'kg', bodyweight: [{ d: '2026-09-01', w: 79, t: 1 }] }),
  );

  assert.equal(readAccountState('legacy-user').revision, 0);
  const saved = saveAccountState('legacy-user', {
    unit: 'kg',
    lang: 'en',
    bodyweight: [{ d: '2026-09-01', w: 79, t: 1 }],
  });

  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.state._sync, { schema: 1, revision: 1, requireRevision: false });
  assert.equal(saved.state.lang, 'en');
});

test('HealthKit-enabled state requires a base revision', t => {
  useTemporaryDataDir(t);
  saveAccountState('required-user', { unit: 'kg', bodyweight: [] });
  const configured = configureHealthKit('required-user', {
    enabled: true,
    timeZone: 'America/Los_Angeles',
  });

  assert.throws(
    () => saveAccountState('required-user', { unit: 'kg', bodyweight: [] }),
    error => error?.code === 'client_update_required' && error.revision === configured.revision,
  );
});

test('generic saves preserve server-owned fields and strip active workouts', t => {
  useTemporaryDataDir(t);
  saveAccountState('reserved-user', { unit: 'kg', bodyweight: [], lang: 'en' });
  configureHealthKit('reserved-user', { enabled: true, timeZone: 'Etc/UTC' });
  const before = readAccountState('reserved-user');

  const saved = saveAccountState('reserved-user', {
    unit: 'kg',
    bodyweight: [],
    lang: 'pt-BR',
    active: { id: 'device-only' },
    _healthkit: { schema: 999, enabled: false, token: 'must-not-be-stored' },
    _sync: { schema: 999, revision: 999, requireRevision: false },
  }, before.revision);

  assert.equal(saved.state.lang, 'pt-BR');
  assert.equal(saved.state.active, undefined);
  assert.deepEqual(saved.state._healthkit, before.state._healthkit);
  assert.deepEqual(saved.state._sync, { schema: 1, revision: before.revision + 1, requireRevision: true });
  assert.doesNotMatch(JSON.stringify(saved.state), /must-not-be-stored/);
});

test('generic data routes expose revisions and reject missing or stale revisions after enablement', async t => {
  const dataDir = useTemporaryDataDir(t, 'opengym-data-route-');
  const uid = 'route-user';
  const secret = 'route-test-secret';
  fs.writeFileSync(path.join(dataDir, 'secret'), secret);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: uid, name: 'Route User' }],
    creds: [],
    subs: [],
    invites: [],
  }));
  const base = await startApi(t, dataDir);
  const payload = `${uid}:${Date.now() + 60000}:0`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const headers = { Authorization: `Bearer ${payload}.${mac}`, 'Content-Type': 'application/json' };

  let response = await fetch(base + '/api/data', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ state: { unit: 'kg', bodyweight: [], lang: 'en' } }),
  });
  assert.equal(response.status, 200);
  const initial = await response.json();
  assert.equal(initial.revision, 1);
  assert.equal(initial.state.lang, 'en');

  response = await fetch(base + '/api/data', { headers });
  assert.deepEqual(await response.json(), {
    state: initial.state,
    revision: 1,
    requireRevision: false,
  });

  const configured = configureHealthKit(uid, { enabled: true, timeZone: 'Etc/UTC' });
  response = await fetch(base + '/api/data', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ state: { unit: 'kg', bodyweight: [], lang: 'pt-BR' } }),
  });
  assert.equal(response.status, 428);
  assert.deepEqual(await response.json(), { error: 'client_update_required', revision: configured.revision });

  response = await fetch(base + '/api/data', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ state: { unit: 'kg', bodyweight: [], lang: 'pt-BR' }, baseRevision: 1 }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'state_conflict', revision: configured.revision });
});
