// End-to-end test: the v0.1 doc's §5 "four-call promise" run live against
// test.aretehosting.com, plus the corrected-behavior negative cases.
//
//   gateway (this repo, spawned)  <-- local REST/SSE -->  this script
//   gateway  <-- CNS/CP -->  realm  <-- CNS/CP -->  peer provider (spawned)
//
// Run: npm run test:e2e   (needs network to test.aretehosting.com + cp.padi.io)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REALM_HOST = process.env.E2E_REALM ?? 'test.aretehosting.com';
// Overridable so the suite can run against a local realm (etcd + cns-cli +
// orchestrator) instead of a shared one — see cns-cli/test/run-socket-security.sh.
const REALM_PROTOCOL = process.env.E2E_PROTOCOL ?? 'wss:';
const REALM_PORT = Number(process.env.E2E_PORT ?? 443);
const PORT = 8437;
const TOKEN = 'e2e-local-token';
const BASE = `http://127.0.0.1:${PORT}/v0`;
const RUN = crypto.randomBytes(4).toString('hex');
const CTX = `gwe2e${RUN}`;
const NODE = 'gw-e2e-node';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function api(method, p, body) {
  return fetch(BASE + p, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function waitFor(desc, fn, timeoutMs, everyMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout waiting for ${desc}`);
}

// ---------- setup: isolated config + data dir ----------
const dataDir = path.join(root, `data-e2e-${RUN}`);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(root, `config-e2e-${RUN}.json`),
  JSON.stringify({
    port: PORT,
    bind: '127.0.0.1',
    localToken: TOKEN,
    systemName: 'Arete Gateway E2E',
    dataDir: `data-e2e-${RUN}`,
    realms: { test: { protocol: REALM_PROTOCOL, host: REALM_HOST, port: REALM_PORT } },
  }),
);
// loadConfig reads config.json from root — use a scratch root via env
const scratchRoot = path.join(root, `root-e2e-${RUN}`);
fs.mkdirSync(scratchRoot, { recursive: true });
fs.renameSync(path.join(root, `config-e2e-${RUN}.json`), path.join(scratchRoot, 'config.json'));

const children = [];
function cleanup(code) {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(code);
  }, 500);
}

try {
  // ---------- start gateway ----------
  const gw = spawn('node', [path.join(root, 'src', 'server.js')], {
    env: {
      ...process.env,
      ARETE_GATEWAY_ROOT: scratchRoot,
      ARETE_SYSTEM_SEED: `gw-e2e-${RUN}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gw);
  gw.stdout.on('data', (d) => process.stdout.write(`[gw] ${d}`));
  gw.stderr.on('data', (d) => process.stdout.write(`[gw!] ${d}`));

  await waitFor(
    'gateway up + realm connected',
    async () => {
      try {
        const res = await api('GET', '/status');
        if (!res.ok) return false;
        const s = await res.json();
        return s.realms.find((r) => r.realm === 'test')?.state === 'connected' ? s : false;
      } catch {
        return false;
      }
    },
    20000,
  );
  check('gateway starts and connects to realm', true);

  // Wrong local token is rejected.
  const unauth = await fetch(`${BASE}/status`, { headers: { Authorization: 'Bearer wrong' } });
  check('local auth enforced (401)', unauth.status === 401);

  // ---------- SSE subscription (call 4 of the walkthrough, done early to catch everything) ----------
  const events = [];
  const sseAbort = new AbortController();
  fetch(`${BASE}/events?stream=sse&realm=test&token=${TOKEN}`, { signal: sseAbort.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      let buf = '';
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
        }
      }
    })
    .catch(() => {}); // reader aborts at teardown — expected

  // ---------- the four-call walkthrough ----------
  let res = await api('PUT', `/realms/test/nodes/${NODE}`, { name: 'E2E Lobby Light' });
  check('PUT node', res.status === 200, `status ${res.status}`);

  res = await api('PUT', `/realms/test/nodes/${NODE}/contexts/${CTX}`, { name: 'E2E Lobby' });
  check('PUT context', res.status === 200, `status ${res.status}`);

  const declPath = `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/consumer/padi.light`;
  res = await api('PUT', declPath, { properties: { cState: '0', cLabel: 'E2E Light' } });
  check('PUT declaration (consumer padi.light)', res.status === 201, `status ${res.status}`);

  // Idempotent re-PUT -> 200; different body -> 409.
  res = await api('PUT', declPath, { properties: { cState: '0', cLabel: 'E2E Light' } });
  check('identical redeclaration is a no-op 200', res.status === 200, `status ${res.status}`);
  res = await api('PUT', declPath, { properties: { cState: '1' } });
  check('conflicting redeclaration -> 409', res.status === 409, `status ${res.status}`);

  // ---------- corrected-behavior negative cases ----------
  res = await api(
    'PUT',
    `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/consumer/definitely.not.a.profile`,
    {},
  );
  check('unregistered profile -> 422', res.status === 422, `status ${res.status}`);

  res = await api('PUT', `${declPath}/properties/sOut`, { value: '1' });
  check('writing the peer role\'s property -> 422', res.status === 422, `status ${res.status}`);

  // Retraction round-trip: declare a throwaway capability, retract it, confirm
  // it is gone. (The main declaration is retracted in teardown, after bind.)
  const tmpDecl = `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/provider/padi.light`;
  await api('PUT', tmpDecl, {});
  res = await api('DELETE', tmpDecl);
  check('DELETE declaration -> retracted', res.status === 200, `status ${res.status}`);
  res = await api('GET', tmpDecl);
  check('retracted declaration is gone -> 404', res.status === 404, `status ${res.status}`);

  // ---------- bind: spawn the peer provider ----------
  const peer = spawn('node', [path.join(root, 'test', 'peer-provider.js'), REALM_HOST, CTX], {
    env: { ...process.env, ARETE_SYSTEM_ID: crypto.randomUUID() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(peer);
  const peerLines = [];
  peer.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      peerLines.push(line);
      console.log(`[peer] ${line}`);
    }
  });
  peer.stderr.on('data', (d) => process.stdout.write(`[peer!] ${d}`));

  const created = await waitFor(
    'connection.created event',
    async () => events.find((e) => e.type === 'connection.created' && e.profile === 'padi.light'),
    60000,
  );
  check('connection.created event received', true, `conn ${created.conn}`);

  const changed = await waitFor(
    'property.changed sOut=1 from peer',
    async () =>
      events.find(
        (e) => e.type === 'property.changed' && e.data?.property === 'sOut' && e.data?.value === '1',
      ),
    30000,
  );
  check(
    'property.changed sOut=1 with origin=peer',
    changed.data.origin === 'peer',
    `origin ${changed.data.origin}`,
  );

  // ---------- app writes back: capability-level cState (propagated) ----------
  res = await api('PUT', `${declPath}/properties/cState`, { value: '1' });
  check('PUT cState=1 (capability level, propagated)', res.status === 200, `status ${res.status}`);

  await waitFor(
    'peer sees cState=1',
    async () => peerLines.some((l) => l.includes('PEER SAW cState=1')),
    30000,
  );
  check('peer observed cState=1 on its connection', true);

  // ---------- read surfaces ----------
  res = await api('GET', `${declPath}/connections`);
  const conns = await res.json();
  check(
    'GET connections shows bound connection with merged properties',
    conns.length >= 1 && conns[0].properties.sOut === '1' && conns[0].properties.cState === '1',
    JSON.stringify(conns[0]?.properties ?? {}),
  );

  // Addressed write on the specific connection.
  res = await api('PUT', `${declPath}/connections/${conns[0].conn}/properties/cLabel`, {
    value: 'Addressed Label',
  });
  check('PUT addressed (per-connection) property', res.status === 200, `status ${res.status}`);

  res = await api('GET', `/realms/test/contexts/${CTX}/participants`);
  const parts = await res.json();
  check(
    'participants shows both roles',
    parts.some((p) => p.role === 'provider') && parts.some((p) => p.role === 'consumer'),
    JSON.stringify(parts.map((p) => `${p.role}/${p.profile}`)),
  );

  res = await api('GET', '/realms/test');
  const realmInfo = await res.json();
  check('realm describe never echoes token', !('token' in realmInfo), Object.keys(realmInfo).join(','));

  sseAbort.abort();

  // ---------- teardown: retract what this run declared ----------
  // Without this every e2e run left a permanent participant on the realm.
  // Retraction is scoped to the gateway's own subtree; the peer cleans up its
  // own on exit. The substrate severs the connection as a consequence.
  try {
    // Ask the peer to retract its own subtree (it cannot be reached by ours).
    peer.stdin.write('RETRACT\n');
    await waitFor(
      'peer retracts its own subtree',
      async () => peerLines.some((l) => l.includes('PEER RETRACTED')),
      8000,
    );

    const del = await api('DELETE', `/realms/test/nodes/${NODE}`);
    check('teardown: node retracted', del.status === 200, `status ${del.status}`);

    await new Promise((r) => setTimeout(r, 1500));
    const gone = await api('GET', `/realms/test/nodes/${NODE}`);
    check('teardown: node is gone', gone.status === 404, `status ${gone.status}`);
  } catch (e) {
    check('teardown: node retracted', false, e.message);
  }

  // ---------- summary ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== E2E: ${results.length - failed.length}/${results.length} passed ===`);
  cleanup(failed.length ? 1 : 0);
} catch (err) {
  console.error('E2E ABORT:', err.message);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== E2E: ${results.length - failed.length}/${results.length} passed (aborted) ===`);
  cleanup(1);
}
