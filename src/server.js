// Arete Gateway entry point.

import http from 'node:http';
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    authenticate(req, url);
    await api(req, res, url);
  } catch (err) {
    if (!(err instanceof ApiError) && !err.status) console.error('[gateway] error:', err);
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
});

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
