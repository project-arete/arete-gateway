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
import { sendError, ApiError } from './util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(process.env.ARETE_GATEWAY_ROOT ?? root);

const store = new Store(cfg.dataDir);
const registry = new Registry(cfg.dataDir);
const hub = new EventHub();
const manager = new RealmManager({ store, hub, registry, systemName: cfg.systemName });

const api = createApi({ cfg, store, manager, hub, registry });

const uiFile = path.join(root, 'ui', 'index.html');

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

    authenticate(req, url);
    await api(req, res, url);
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

function authenticate(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // ?token= accepted for SSE only (EventSource cannot set headers).
  const query = url.pathname === '/v0/events' ? url.searchParams.get('token') : null;
  if ((bearer ?? query) !== cfg.localToken) {
    throw new ApiError(401, 'unauthorized', 'missing or invalid local API token');
  }
}

server.listen(cfg.port, cfg.bind, () => {
  console.log(`[gateway] listening on http://${cfg.bind}:${cfg.port}/v0`);
  manager.startFromConfig(cfg.realms);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[gateway] ${sig} — shutting down`);
    manager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
