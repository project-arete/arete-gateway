// Gateway configuration: config.json (optional) + data dir with generated
// local token and system-identity seed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  cfg.port = cfg.port ?? 8420;
  cfg.bind = cfg.bind ?? '127.0.0.1'; // localhost by default; network exposure is explicit opt-in
  cfg.systemName = cfg.systemName ?? 'Arete Gateway';
  cfg.realms = cfg.realms ?? {};
  cfg.corsOrigins = cfg.corsOrigins ?? []; // browser origins allowed to call the API cross-origin

  cfg.dataDir = path.resolve(rootDir, cfg.dataDir ?? 'data');
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // Local API bearer token: from config, else generated once and persisted.
  if (!cfg.localToken) {
    const tokFile = path.join(cfg.dataDir, 'local-token');
    if (fs.existsSync(tokFile)) {
      cfg.localToken = fs.readFileSync(tokFile, 'utf8').trim();
    } else {
      cfg.localToken = crypto.randomBytes(24).toString('base64url');
      fs.writeFileSync(tokFile, cfg.localToken, { mode: 0o600 });
      console.log(`[gateway] generated local API token in ${tokFile}`);
    }
  }

  // Stable system identity for the SDK (one system across all realms — deliberate).
  // Honors an externally provided ARETE_SYSTEM_ID/SEED; otherwise seeds once and persists.
  if (!process.env.ARETE_SYSTEM_ID && !process.env.ARETE_SYSTEM_SEED) {
    const seedFile = path.join(cfg.dataDir, 'system-seed');
    if (!fs.existsSync(seedFile)) {
      fs.writeFileSync(seedFile, crypto.randomUUID(), { mode: 0o600 });
    }
    process.env.ARETE_SYSTEM_SEED = fs.readFileSync(seedFile, 'utf8').trim();
  }

  return cfg;
}
