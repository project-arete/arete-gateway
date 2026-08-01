// Arete Gateway entry point.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Registry } from './registry.js';
import { EventHub } from './events.js';
import { RealmManager } from './realm-manager.js';
import { createApi } from './api.js';
import { WebhookManager } from './webhooks.js';
import { CapabilityManager } from './capabilities.js';
import { sendError, ApiError } from './util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(process.env.ARETE_GATEWAY_ROOT ?? root);

const store = new Store(cfg.dataDir);
const registry = new Registry(cfg.dataDir);
const hub = new EventHub();
const manager = new RealmManager({ store, hub, registry, systemName: cfg.systemName });
const capabilities = new CapabilityManager({ store });
const webhooks = new WebhookManager({
  store,
  hub,
  log: (level, message) => console.log(`[webhooks:${level}] ${message}`),
});

const api = createApi({ cfg, store, manager, hub, registry, webhooks, capabilities });

const uiFile = path.join(root, 'ui', 'index.html');
const docsFile = path.join(root, 'ui', 'docs.html');
const specFile = path.join(root, 'docs', 'openapi.json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (applyCors(req, res)) return; // CORS preflight handled

    // Console UI — static, unauthenticated (the page itself holds no secrets;
    // every API call it makes still needs the local token).
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/')) {
      if (url.pathname === '/') {
        res.writeHead(302, { Location: '/ui' });
        return res.end();
      }
      const html = fs.readFileSync(uiFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    // API reference — both unauthenticated: the spec is the public contract
    // and holds no secrets; the Swagger UI page takes the token via Authorize.
    if (req.method === 'GET' && url.pathname === '/v0/openapi.json') {
      const spec = fs.readFileSync(specFile);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': spec.length,
        'Access-Control-Allow-Origin': '*', // let external spec viewers load it
      });
      return res.end(spec);
    }
    if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) {
      const html = fs.readFileSync(docsFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    const auth = authenticate(req, url);
    await api(req, res, url, auth);
  } catch (err) {
    if (!(err instanceof ApiError) && !err.status) console.error('[gateway] error:', err);
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
});

// Browser clients from other origins (a Pages-hosted console pointed at this
// gateway) need CORS. Allowlist is explicit config — default empty, meaning
// no cross-origin browser access. Returns true if the request was a handled
// OPTIONS preflight.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !cfg.corsOrigins.length) return false;
  if (cfg.corsOrigins.includes(origin) || cfg.corsOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// Returns the authorisation context for this request. Two kinds of credential:
//
//   local       the gateway's API token — full access, what apps use.
//   capability  a device token naming ONE connection and a fixed set of
//               properties on it. Everything else is refused (see api.js).
//
// A capability is deliberately not a weaker local token: it is a different
// kind of thing, and the API treats it as such.
function authenticate(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // ?token= accepted for SSE only (EventSource cannot set headers).
  const query = url.pathname === '/v0/events' ? url.searchParams.get('token') : null;
  const presented = bearer ?? query;

  if (presented === cfg.localToken) return { kind: 'local' };

  const cap = capabilities.resolve(presented);
  if (cap) return { kind: 'capability', cap };

  throw new ApiError(401, 'unauthorized', 'missing or invalid local API token');
}

server.listen(cfg.port, cfg.bind, () => {
  console.log(`[gateway] listening on http://${cfg.bind}:${cfg.port}/v0`);
  manager.startFromConfig(cfg.realms);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[gateway] ${sig} — shutting down`);
    manager.stopAll();
    webhooks.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
