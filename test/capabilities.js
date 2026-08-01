// Capability tokens: the constrained-device pattern, end to end.
//
// The interesting assertions are the negative ones. A capability that lets a
// device set cState is only useful if it CANNOT do anything else — so this
// tests the boundary far harder than the happy path:
//
//   * a device token writes the property it names, on the connection it names
//   * ...and is refused on any other property, connection, or route
//   * it cannot mint further capabilities (no escalation)
//   * it cannot read the declaration tree, events, or webhooks
//   * minting is ATTENUATING — you cannot mint for a property the gateway
//     itself may not write (the peer's side)
//   * revocation works, and severing the connection kills it for free
//   * the token is returned once and never stored in the clear
//
// Usage: E2E_REALM=... [E2E_PROTOCOL=ws: E2E_PORT=8080] node test/capabilities.js

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testSystemId, testSystemSeed, retractSystems } from './identities.js';

// Stable ids per suite: re-running reuses these instead of minting new systems.
let peerIndex = 0;
const usedSystemIds = [];
function recordId(id) { usedSystemIds.push(id); return id; }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REALM_HOST = process.env.E2E_REALM ?? 'test.aretehosting.com';
const REALM_PROTOCOL = process.env.E2E_PROTOCOL ?? 'wss:';
const REALM_PORT = Number(process.env.E2E_PORT ?? 443);

const GW_PORT = 8461;
const TOKEN = 'capability-test-token';
const BASE = `http://127.0.0.1:${GW_PORT}/v0`;

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cap-'));
const children = [];
async function cleanup(code) {
  // Ask the gateway for its own system id before killing it, so we can remove
  // the system record too — retracting only the node leaves cns/<id>/name etc
  // behind, one per run, which is how the test realm filled up with 24 dead
  // systems in a day.
  try {
    const st = await (await call('GET', '/status')).json();
    for (const r of st.realms ?? []) if (r.systemId) usedSystemIds.push(r.systemId);
  } catch { /* gateway already gone */ }

  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }

  try {
    await retractSystems(usedSystemIds, {
      host: REALM_HOST, protocol: REALM_PROTOCOL, port: REALM_PORT,
    });
  } catch { /* best effort */ }

  setTimeout(() => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 400);
}

const call = (method, p, body, token = TOKEN) =>
  fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function waitFor(desc, fn, timeoutMs, everyMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  console.log(`   (timed out waiting for ${desc})`);
  return false;
}

const stamp = Date.now().toString(36);
const NODE = 'cap-node';
const CTX = `cap-ctx-${stamp}`;
const DECL = `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/consumer/padi.light`;

try {
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify({
    port: GW_PORT,
    bind: '127.0.0.1',
    systemName: 'Capability Test GW',
    localToken: TOKEN,
    realms: { test: { protocol: REALM_PROTOCOL, host: REALM_HOST, port: REALM_PORT } },
  }));

  const gw = spawn('node', [path.join(root, 'src', 'server.js')], {
    env: { ...process.env, ARETE_GATEWAY_ROOT: scratch, ARETE_SYSTEM_SEED: testSystemSeed('capabilities') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gw);
  gw.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[gw] ${d}`); });

  const up = await waitFor('gateway', async () => {
    try { return (await call('GET', '/status')).ok; } catch { return false; }
  }, 20000);
  check('gateway starts', up);
  if (!up) throw new Error('gateway did not start');

  // ---------- get a bound connection to mint against ----------
  await call('PUT', `/realms/test/nodes/${NODE}`, { name: 'Capability Test Light' });
  await call('PUT', `/realms/test/nodes/${NODE}/contexts/${CTX}`, { name: 'Capability Ctx' });
  await call('PUT', DECL, { properties: { cState: '0' } });

  const peer = spawn('node', [path.join(root, 'test', 'peer-provider.js'), REALM_HOST, CTX], {
    env: { ...process.env, ARETE_SYSTEM_ID: recordId(testSystemId('capabilities', 'peer', peerIndex++)) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(peer);
  let peerOut = '';
  peer.stdout.on('data', (d) => { peerOut += d; });

  let connId = null;
  const bound = await waitFor('bind', async () => {
    const r = await call('GET', `${DECL}/connections`);
    if (!r.ok) return false;
    const list = await r.json();
    if (list.length) { connId = list[0].conn; return true; }
    return false;
  }, 45000);
  check('a connection exists to mint against', bound, 'never bound');
  if (!bound) throw new Error('no connection');

  const CONN = `${DECL}/connections/${connId}`;

  // ---------- minting ----------
  let res = await call('POST', `${CONN}/capabilities`, {
    properties: ['cState'], direction: 'write', label: 'wall switch',
  });
  const minted = await res.json();
  check('mint returns 201 with a token', res.status === 201 && typeof minted.token === 'string',
    `status ${res.status}`);
  const DEVICE = minted.token;

  check('minted capability names the connection and properties',
    minted.conn === connId && minted.properties.join() === 'cState', JSON.stringify(minted).slice(0, 140));

  // ATTENUATION: sOut is the provider's property — the gateway is a consumer
  // here and may not write it, so it must not be able to delegate it.
  res = await call('POST', `${CONN}/capabilities`, { properties: ['sOut'], direction: 'write' });
  check('cannot mint for a property the gateway itself may not write (attenuating)',
    res.status === 422, `status ${res.status}`);

  res = await call('GET', `${CONN}/capabilities`);
  const listed = await res.json();
  check('listing capabilities never reveals a token',
    !JSON.stringify(listed).includes(DEVICE) && listed.length === 1, JSON.stringify(listed).slice(0, 120));

  const stateFile = JSON.parse(fs.readFileSync(path.join(scratch, 'data', 'state.json'), 'utf8'));
  check('the token is not stored in the clear (hash only)',
    !JSON.stringify(stateFile).includes(DEVICE)
    && Object.values(stateFile.capabilities)[0].hash.length === 64);

  // ---------- the device: what it CAN do ----------
  res = await call('PUT', `${CONN}/properties/cState`, { value: '1' }, DEVICE);
  check('device writes the property its capability names', res.status === 200, `status ${res.status}`);

  const seen = await waitFor('peer sees cState=1', async () => peerOut.includes('PEER SAW cState=1'), 20000);
  check('the write actually reached the peer across the connection', seen);

  // Direction is enforced: a write-only capability is not a read capability.
  res = await call('GET', `${CONN}/properties`, null, DEVICE);
  check('a write-only capability cannot read -> 403', res.status === 403, `status ${res.status}`);

  // A readwrite capability can, and sees ONLY what it names — not the merged
  // view an app gets, which would leak the peer's properties to the device.
  const rw = await (await call('POST', `${CONN}/capabilities`, {
    properties: ['cState'], direction: 'readwrite', label: 'panel',
  })).json();
  res = await call('GET', `${CONN}/properties`, null, rw.token);
  const view = await res.json();
  check('a readwrite capability reads ONLY the properties it names',
    res.status === 200 && Object.keys(view).join() === 'cState',
    `status ${res.status} ${JSON.stringify(view)}`);
  await call('DELETE', `${CONN}/capabilities/${rw.capId}`);

  // ---------- the device: what it CANNOT do ----------
  res = await call('PUT', `${CONN}/properties/cLabel`, { value: 'x' }, DEVICE);
  check('refused on a property outside the capability -> 403', res.status === 403, `status ${res.status}`);

  res = await call('PUT', `${DECL}/connections/not-this-one/properties/cState`, { value: '1' }, DEVICE);
  check('refused on a different connection -> 403', res.status === 403, `status ${res.status}`);

  res = await call('PUT', `${DECL}/properties/cState`, { value: '1' }, DEVICE);
  check('refused on the declaration-level property route -> 403', res.status === 403, `status ${res.status}`);

  res = await call('GET', `/realms/test/nodes/${NODE}`, null, DEVICE);
  check('refused on the declaration tree -> 403', res.status === 403, `status ${res.status}`);

  res = await call('GET', '/status', null, DEVICE);
  check('refused on /status -> 403', res.status === 403, `status ${res.status}`);

  res = await call('GET', '/webhooks', null, DEVICE);
  check('refused on /webhooks -> 403', res.status === 403, `status ${res.status}`);

  res = await call('POST', `${CONN}/capabilities`, { properties: ['cState'] }, DEVICE);
  check('cannot mint further capabilities (no escalation) -> 403', res.status === 403, `status ${res.status}`);

  res = await call('DELETE', `/realms/test/nodes/${NODE}`, null, DEVICE);
  check('cannot retract anything -> 403', res.status === 403, `status ${res.status}`);

  res = await call('GET', '/status', null, 'acap_not-a-real-token');
  check('a forged capability token is unauthorised -> 401', res.status === 401, `status ${res.status}`);

  // ---------- revocation ----------
  res = await call('DELETE', `${CONN}/capabilities/${minted.capId}`);
  check('capability revoked', res.status === 200, `status ${res.status}`);

  res = await call('PUT', `${CONN}/properties/cState`, { value: '0' }, DEVICE);
  check('a revoked capability stops working -> 401', res.status === 401, `status ${res.status}`);

  // ---------- severing kills a capability for free ----------
  const second = await (await call('POST', `${CONN}/capabilities`, { properties: ['cState'] })).json();
  try { peer.stdin.write('RETRACT\n'); } catch { /* gone */ }
  await waitFor('peer retract', async () => peerOut.includes('PEER RETRACTED'), 12000);

  const dead = await waitFor('capability dies with the connection', async () => {
    const r = await call('PUT', `${CONN}/properties/cState`, { value: '1' }, second.token);
    return r.status === 410;
  }, 20000);
  check('when the substrate severs, the capability refers to nothing -> 410', dead);

  // ---------- teardown ----------
  const del = await call('DELETE', `/realms/test/nodes/${NODE}`);
  check('teardown: node retracted', del.status === 200, `status ${del.status}`);
} catch (err) {
  check('suite ran without throwing', false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== capabilities: ${results.length - failed.length}/${results.length} passed ===`);
await cleanup(failed.length ? 1 : 0);
