// Peer identification.
//
// The gateway used to INFER the far end of a connection: scan the context for
// anyone declaring the complementary role, take the first match. With two
// participants that is usually right; with three it is usually wrong, and the
// wrong answer travelled out in connection.created and every webhook built on
// it.
//
// The substrate states the answer outright — alongside a connection's
// properties it writes an attribute named for the opposite role:
//
//   …/consumer/padi.light/connections/<id>/provider
//     = "cns/<system>/nodes/<node>/contexts/<ctx>"
//
// So this test puts THREE providers in one context and asserts the three
// connections name three DIFFERENT peers. A guess cannot pass it.
//
// Usage: E2E_REALM=... [E2E_PROTOCOL=ws: E2E_PORT=8080] node test/peer-identity.js

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

const GW_PORT = 8481;
const TOKEN = 'peer-identity-token';
const BASE = `http://127.0.0.1:${GW_PORT}/v0`;
const PEERS = 3;

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-peer-'));
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

const call = (method, p, body) =>
  fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
const NODE = 'peer-id-node';
const CTX = `peer-id-${stamp}`;
const DECL = `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/consumer/padi.light`;

try {
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify({
    port: GW_PORT,
    bind: '127.0.0.1',
    systemName: 'Peer Identity Test GW',
    localToken: TOKEN,
    realms: { test: { protocol: REALM_PROTOCOL, host: REALM_HOST, port: REALM_PORT } },
  }));

  const gw = spawn('node', [path.join(root, 'src', 'server.js')], {
    env: { ...process.env, ARETE_GATEWAY_ROOT: scratch, ARETE_SYSTEM_SEED: testSystemSeed('peer-identity') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gw);
  gw.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[gw] ${d}`); });

  const up = await waitFor('gateway', async () => {
    try { return (await call('GET', '/status')).ok; } catch { return false; }
  }, 20000);
  check('gateway starts', up);
  if (!up) throw new Error('gateway did not start');

  await call('PUT', `/realms/test/nodes/${NODE}`, { name: 'Peer Identity Light' });
  await call('PUT', `/realms/test/nodes/${NODE}/contexts/${CTX}`, { name: 'Peer Identity Ctx' });
  await call('PUT', DECL, { properties: { cState: '0' } });

  // Three providers, one context — the case a heuristic cannot get right.
  const peers = [];
  for (let i = 0; i < PEERS; i++) {
    const p = spawn('node', [path.join(root, 'test', 'peer-provider.js'), REALM_HOST, CTX], {
      env: { ...process.env, ARETE_SYSTEM_ID: recordId(testSystemId('peer-identity', 'peer', peerIndex++)) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(p);
    peers.push(p);
    await new Promise((r) => setTimeout(r, 1200));
  }

  const bound = await waitFor(`${PEERS} connections`, async () => {
    const r = await call('GET', `${DECL}/connections`);
    return r.ok && (await r.json()).length >= PEERS;
  }, 60000);
  check(`all ${PEERS} providers bound`, bound);

  // Let any deferred connection.created events settle.
  await new Promise((r) => setTimeout(r, 3000));

  const evs = await (await call('GET', '/events?limit=100')).json();
  const created = evs.events.filter((e) => e.type === 'connection.created' && e.context === CTX);
  check(`${PEERS} connection.created events`, created.length === PEERS, `saw ${created.length}`);

  const systems = created.map((e) => e.data?.peer?.system).filter(Boolean);
  check('every connection names a peer', systems.length === created.length,
    `${systems.length}/${created.length}`);

  // THE assertion: distinct connections must name distinct peers. The old
  // heuristic returned the same first match every time.
  check('each connection names a DIFFERENT peer (identified, not guessed)',
    new Set(systems).size === created.length, `${new Set(systems).size} distinct of ${created.length}`);

  // The authoritative record carries the peer's context; the fallback guess
  // cannot. So requiring context on every peer is the same as requiring that
  // none of them were guessed.
  check('peer carries system, node and context (i.e. came from the record)',
    created.every((e) => e.data?.peer?.system && e.data?.peer?.node && e.data?.peer?.context),
    JSON.stringify(created.map((e) => e.data?.peer)).slice(0, 220));

  check('no peer was inferred', created.every((e) => !e.data?.peer?.inferred));

  // Same fact should back the connections view.
  const conns = await (await call('GET', `${DECL}/connections`)).json();
  check('connection records carry the peer attribute',
    conns.every((c) => typeof c.attributes?.provider === 'string' && c.attributes.provider.startsWith('cns/')),
    JSON.stringify(conns[0]?.attributes ?? {}));

  // ---------- teardown ----------
  for (const p of peers) { try { p.stdin.write('RETRACT\n'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 4000));
  const del = await call('DELETE', `/realms/test/nodes/${NODE}`);
  check('teardown: node retracted', del.status === 200, `status ${del.status}`);
} catch (err) {
  check('suite ran without throwing', false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== peer-identity: ${results.length - failed.length}/${results.length} passed ===`);
await cleanup(failed.length ? 1 : 0);
