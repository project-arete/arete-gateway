// OpenAPI conformance: the spec and the router must not drift.
//
// For every operation in docs/openapi.json, the test substitutes placeholder
// path parameters, calls the running gateway, and asserts that (a) the route
// exists (the response is never the router's "no route" 404) and (b) the
// status returned is one the spec documents for that operation. Plus: the
// served spec is byte-identical to the file, /docs serves the Swagger UI
// page, auth is enforced, and an undocumented path yields the no-route 404.
//
// Runs realm-less on purpose: every assertion here is about the local
// contract, not the wire. Run: npm run test:openapi

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8447;
const TOKEN = 'openapi-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString('hex');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const PARAM_VALUES = {
  realm: 'norealm', node: 'oa-node', ctx: 'oa-ctx', role: 'consumer',
  profile: 'padi.light', conn: 'oa-conn', prop: 'cState', hook: 'oa-hook', capId: 'cap_000000000000',
};

function concretize(p) {
  return p.replace(/\{([^}]+)\}/g, (_, name) => {
    if (!(name in PARAM_VALUES)) throw new Error(`no placeholder for path param {${name}}`);
    return PARAM_VALUES[name];
  });
}

async function call(method, p, { auth = true, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html or stream */
  }
  return { status: res.status, body: parsed, text };
}

const isNoRoute = (r) =>
  r.status === 404 &&
  typeof r.body?.error?.message === 'string' &&
  (r.body.error.message.startsWith('no route') || r.body.error.message.startsWith('unknown path'));

// ---------- boot a realm-less gateway ----------
const scratch = path.join(root, `root-e2e-${RUN}`);
fs.mkdirSync(path.join(scratch), { recursive: true });
fs.writeFileSync(
  path.join(scratch, 'config.json'),
  JSON.stringify({ port: PORT, bind: '127.0.0.1', localToken: TOKEN, dataDir: path.join(scratch, 'data'), realms: {} }),
);

const gw = spawn('node', [path.join(root, 'src', 'server.js')], {
  env: { ...process.env, ARETE_GATEWAY_ROOT: scratch, ARETE_SYSTEM_SEED: `oa-${RUN}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
gw.stderr.on('data', (d) => process.stdout.write(`[gw!] ${d}`));

function cleanup(code) {
  try {
    gw.kill('SIGTERM');
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(code);
  }, 400);
}

try {
  // wait for the port
  const up = await (async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await call('GET', '/v0/status');
        if (r.status === 200) return true;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  if (!up) throw new Error('gateway did not come up');

  // ---------- spec sanity ----------
  const specSrc = fs.readFileSync(path.join(root, 'docs', 'openapi.json'), 'utf8');
  const spec = JSON.parse(specSrc);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check('spec parses and is OpenAPI 3.1', spec.openapi?.startsWith('3.1'), spec.openapi);
  check('spec version matches package.json', spec.info?.version === pkg.version, `${spec.info?.version} vs ${pkg.version}`);
  check('every path lives under /v0', Object.keys(spec.paths).every((p) => p.startsWith('/v0')), '');
  check('webhooks section documents event delivery', !!spec.webhooks?.eventDelivery, '');
  check(
    'both security schemes declared',
    !!spec.components?.securitySchemes?.localToken && !!spec.components?.securitySchemes?.capabilityToken,
    '',
  );

  // ---------- served spec == file ----------
  const served = await call('GET', '/v0/openapi.json', { auth: false });
  check('GET /v0/openapi.json needs no auth', served.status === 200, `status ${served.status}`);
  check('served spec identical to docs/openapi.json', served.text === specSrc, `${served.text.length} vs ${specSrc.length} bytes`);

  // ---------- /docs page ----------
  const docs = await call('GET', '/docs', { auth: false });
  check('/docs serves the Swagger UI page', docs.status === 200 && docs.text.includes('swagger-ui'), `status ${docs.status}`);

  // ---------- auth enforced on the API ----------
  const unauth = await call('GET', '/v0/status', { auth: false });
  check('API still requires auth (401 without token)', unauth.status === 401, `status ${unauth.status}`);

  // ---------- every documented operation is routed + answers a documented status ----------
  let opCount = 0;
  let opFailures = 0;
  for (const [rawPath, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'put', 'post', 'delete']) {
      const op = item[method];
      if (!op) continue;
      opCount++;
      const url = concretize(rawPath);
      const needsBody = method === 'put' || method === 'post';
      const r = await call(method.toUpperCase(), url, needsBody ? { body: {} } : {});
      const documented = Object.keys(op.responses).map(Number);
      const okStatus = documented.includes(r.status);
      const routed = !isNoRoute(r);
      if (!okStatus || !routed) {
        opFailures++;
        console.log(
          `      ${method.toUpperCase()} ${rawPath} -> ${r.status} ` +
          `(documented: ${documented.join(',')}) ${routed ? '' : 'NO-ROUTE'} ${r.body?.error?.code ?? ''}`,
        );
      }
    }
  }
  check(`all ${opCount} documented operations are routed and answer documented statuses`, opFailures === 0, `${opFailures} failures`);

  // ---------- undocumented path fails as no-route ----------
  const bogus = await call('GET', '/v0/definitely/not/a/route');
  check('undocumented path yields the no-route 404', isNoRoute(bogus), `status ${bogus.status}`);

  // ---------- spot-check a documented error is real: unknown event type ----------
  const badHook = await call('PUT', '/v0/webhooks/oa-spot', { body: { url: 'http://localhost:1/x', events: ['nope.nope'] } });
  check('422 unknown_event_type is real', badHook.status === 422 && badHook.body?.error?.code === 'unknown_event_type', `status ${badHook.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== OPENAPI: ${results.length - failed.length}/${results.length} passed ===`);
  cleanup(failed.length ? 1 : 0);
} catch (err) {
  console.error('OPENAPI ABORT:', err.message);
  cleanup(1);
}
