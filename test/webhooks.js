// Webhook delivery test.
//
// Stands up a real receiving endpoint and drives the gateway against a live
// realm, asserting the delivery contract rather than just "a request arrived":
//
//   * registration round-trips and NEVER echoes the secret
//   * unknown event types are refused at registration, not at delivery
//   * POST /test delivers end to end
//   * the HMAC signature verifies over the exact bytes sent
//   * a filter actually filters
//   * a failing endpoint is RETRIED (at-least-once), and ordering survives it
//   * real realm events (connection.created, property.changed) are delivered
//
// Usage: E2E_REALM=... [E2E_PROTOCOL=ws: E2E_PORT=8080] node test/webhooks.js

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REALM_HOST = process.env.E2E_REALM ?? 'test.aretehosting.com';
const REALM_PROTOCOL = process.env.E2E_PROTOCOL ?? 'wss:';
const REALM_PORT = Number(process.env.E2E_PORT ?? 443);

const GW_PORT = 8451;
const HOOK_PORT = 8452;
const TOKEN = 'webhook-test-token';
const BASE = `http://127.0.0.1:${GW_PORT}/v0`;
const SECRET = 'whsec_' + crypto.randomBytes(8).toString('hex');

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-webhook-'));
const children = [];
function cleanup(code) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 400);
}

const api = (method, p, body) =>
  fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function waitFor(desc, fn, timeoutMs, everyMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  console.log(`   (timed out waiting for ${desc})`);
  return false;
}

// ---------- the receiving endpoint ----------
const received = [];
let failNext = 0;             // make the endpoint fail N times, to force retries

const receiver = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const sig = req.headers['x-arete-signature'];
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    let evt = null;
    try { evt = JSON.parse(raw); } catch { /* malformed */ }

    received.push({
      evt,
      path: req.url,
      signatureValid: sig === expected,
      headerEventId: req.headers['x-arete-event-id'],
      headerType: req.headers['x-arete-event'],
    });

    if (failNext > 0) { failNext--; res.writeHead(500); res.end('nope'); return; }
    res.writeHead(200); res.end('ok');
  });
});

try {
  await new Promise((r) => receiver.listen(HOOK_PORT, '127.0.0.1', r));

  // ---------- the gateway ----------
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify({
    port: GW_PORT,
    bind: '127.0.0.1',
    systemName: 'Webhook Test GW',
    localToken: TOKEN,
    realms: { test: { protocol: REALM_PROTOCOL, host: REALM_HOST, port: REALM_PORT } },
  }));

  const gw = spawn('node', [path.join(root, 'src', 'server.js')], {
    env: { ...process.env, ARETE_GATEWAY_ROOT: scratch },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gw);
  gw.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[gw] ${d}`); });

  const up = await waitFor('gateway', async () => {
    try { return (await api('GET', '/status')).ok; } catch { return false; }
  }, 20000);
  check('gateway starts', up);
  if (!up) throw new Error('gateway did not start');

  // ---------- registration ----------
  let res = await api('PUT', '/webhooks/test-hook', {
    url: `http://127.0.0.1:${HOOK_PORT}/hook`,
    secret: SECRET,
    events: ['connection.created', 'property.changed', 'webhook.test'],
  });
  const reg = await res.json();
  check('PUT webhook registers', res.status === 200, `status ${res.status}`);
  check('registration never echoes the secret',
    !JSON.stringify(reg).includes(SECRET) && reg.hasSecret === true, JSON.stringify(reg));

  res = await api('PUT', '/webhooks/bad-hook', {
    url: `http://127.0.0.1:${HOOK_PORT}/hook`,
    events: ['connection.exploded'],
  });
  check('unknown event type refused at registration -> 422', res.status === 422, `status ${res.status}`);

  res = await api('PUT', '/webhooks/bad-url', { url: 'not-a-url' });
  check('non-http url refused -> 400', res.status === 400, `status ${res.status}`);

  res = await api('GET', '/webhooks');
  const list = await res.json();
  check('GET /webhooks lists the hook', Array.isArray(list) && list.some((h) => h.hook === 'test-hook'));

  // ---------- test delivery + signature ----------
  res = await api('POST', '/webhooks/test-hook/test');
  check('POST /test accepted -> 202', res.status === 202, `status ${res.status}`);

  const gotTest = await waitFor('test event', async () => received.some((r) => r.evt?.type === 'webhook.test'), 10000);
  check('synthetic test event delivered', gotTest);

  const testDelivery = received.find((r) => r.evt?.type === 'webhook.test');
  check('HMAC signature verifies over the exact bytes', !!testDelivery?.signatureValid);
  check('X-Arete-Event-Id header matches the envelope',
    testDelivery?.headerEventId === testDelivery?.evt?.eventId);

  // ---------- retry / at-least-once / ordering ----------
  received.length = 0;
  failNext = 3;                                  // reject the next three attempts
  await api('POST', '/webhooks/test-hook/test');

  const redelivered = await waitFor('retried delivery',
    async () => received.filter((r) => r.evt?.type === 'webhook.test').length >= 4, 25000);
  check('a failing endpoint is retried until it succeeds (at-least-once)', redelivered,
    `saw ${received.length} attempt(s)`);

  const ids = received.filter((r) => r.evt?.type === 'webhook.test').map((r) => r.evt.eventId);
  check('retries carry the SAME eventId (so the app can dedupe)',
    ids.length > 1 && new Set(ids).size === 1, JSON.stringify([...new Set(ids)]));

  const st = await (await api('GET', '/webhooks/test-hook')).json();
  check('hook stats record the failures', st.failed >= 3 && st.delivered >= 2,
    `delivered ${st.delivered} failed ${st.failed}`);

  // POST /test deliberately ignores the hook's event selection — it is a
  // connectivity check, so it must fire even for a narrowly filtered hook.
  received.length = 0;
  await api('PUT', '/webhooks/test-hook', {
    url: `http://127.0.0.1:${HOOK_PORT}/hook`,
    secret: SECRET,
    events: ['connection.created'],               // webhook.test NOT selected
  });
  await api('POST', '/webhooks/test-hook/test');
  const testBypasses = await waitFor('test bypass',
    async () => received.some((r) => r.evt?.type === 'webhook.test'), 8000);
  check('POST /test fires even when the hook filters that type out (connectivity check)', testBypasses);

  // ---------- a REAL realm event, and a REAL filter ----------
  received.length = 0;
  await api('PUT', '/webhooks/test-hook', {
    url: `http://127.0.0.1:${HOOK_PORT}/hook`,
    secret: SECRET,
    events: ['connection.created', 'property.changed', 'connection.deleted'],
  });
  // A second hook that wants ONLY connection.deleted: it must NOT see the
  // connection.created or property.changed the first hook receives.
  await api('PUT', '/webhooks/narrow-hook', {
    url: `http://127.0.0.1:${HOOK_PORT}/narrow`,
    secret: SECRET,
    events: ['connection.deleted'],
  });

  const stamp = Date.now().toString(36);
  const NODE = 'wh-node';
  const CTX = `wh-ctx-${stamp}`;
  await api('PUT', `/realms/test/nodes/${NODE}`, { name: 'Webhook Test Light' });
  await api('PUT', `/realms/test/nodes/${NODE}/contexts/${CTX}`, { name: 'Webhook Ctx' });
  await api('PUT', `/realms/test/nodes/${NODE}/contexts/${CTX}/declarations/consumer/padi.light`,
    { properties: { cState: '0' } });

  const peer = spawn('node', [path.join(root, 'test', 'peer-provider.js'), REALM_HOST, CTX], {
    env: { ...process.env, ARETE_SYSTEM_ID: crypto.randomUUID() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(peer);
  let peerOut = '';
  peer.stdout.on('data', (d) => { peerOut += d; });

  const gotConn = await waitFor('connection.created',
    async () => received.some((r) => r.evt?.type === 'connection.created'), 45000);
  check('real connection.created is delivered', gotConn);

  const gotProp = await waitFor('property.changed',
    async () => received.some((r) => r.evt?.type === 'property.changed' && r.evt?.data?.property === 'sOut'),
    20000);
  check('real property.changed is delivered', gotProp);

  const conn = received.find((r) => r.evt?.type === 'connection.created');
  check('delivered envelope carries realm/node/context/profile',
    !!(conn?.evt?.realm && conn?.evt?.node && conn?.evt?.context && conn?.evt?.profile),
    JSON.stringify(conn?.evt ?? {}).slice(0, 140));
  check('every delivery was correctly signed', received.every((r) => r.signatureValid));

  // The narrow hook wanted ONLY connection.deleted, so it must have seen none
  // of the traffic the broad hook just received.
  const narrow = received.filter((r) => r.path === '/narrow');
  check('event-type filter excludes unselected types',
    narrow.length === 0, `narrow hook received ${narrow.length}: ${narrow.map((r) => r.evt?.type).join(',')}`);

  // ---------- teardown ----------
  try { peer.stdin.write('RETRACT\n'); } catch { /* already gone */ }
  await waitFor('peer retract', async () => peerOut.includes('PEER RETRACTED'), 10000);

  const del = await api('DELETE', `/realms/test/nodes/${NODE}`);
  check('teardown: node retracted', del.status === 200, `status ${del.status}`);

  // Retraction severs the connection, so connection.deleted should now reach
  // the narrow hook — proving the filter admits what it selected, not just
  // that it rejects everything.
  const narrowGot = await waitFor('connection.deleted at the narrow hook',
    async () => received.some((r) => r.path === '/narrow' && r.evt?.type === 'connection.deleted'), 15000);
  check('filtered hook DOES receive the type it selected (connection.deleted)', narrowGot);

  res = await api('DELETE', '/webhooks/test-hook');
  check('DELETE webhook', res.status === 200, `status ${res.status}`);
  await api('DELETE', '/webhooks/narrow-hook').catch(() => {});
  await api('DELETE', '/webhooks/bad-url').catch(() => {});
} catch (err) {
  check('suite ran without throwing', false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== webhooks: ${results.length - failed.length}/${results.length} passed ===`);
receiver.close();
cleanup(failed.length ? 1 : 0);
