// Owns the set of RealmConnections: config-declared + API-attached (persisted).

import { RealmConnection } from './realm.js';
import { ApiError } from './util.js';

export class RealmManager {
  #realms = new Map(); // name -> { conn, source: 'config'|'api' }

  constructor({ store, hub, registry, systemName }) {
    this.deps = { store, hub, registry, systemName };
    this.store = store;
  }

  startFromConfig(configRealms) {
    for (const [name, cfg] of Object.entries(configRealms)) {
      this.#start(name, cfg, 'config');
    }
    for (const [name, cfg] of Object.entries(this.store.getRealms())) {
      if (!this.#realms.has(name)) this.#start(name, cfg, 'api');
    }
  }

  #start(name, cfg, source) {
    const conn = new RealmConnection(name, cfg, this.deps);
    this.#realms.set(name, { conn, source });
    return conn;
  }

  attach(name, body) {
    if (!body.host) throw new ApiError(400, 'bad_request', 'realm body requires "host"');
    const cfg = {
      protocol: body.protocol || 'wss:',
      host: body.host,
      port: body.port ?? 443,
      token: body.token || '',
      insecureTls: !!body.insecureTls,
    };

    // Same-host duplicate guard: two handles onto one realm means double
    // registration under the same system id.
    for (const [existingName, { conn }] of this.#realms) {
      if (existingName !== name && conn.cfg.host === cfg.host && (conn.cfg.port ?? 443) === (cfg.port ?? 443)) {
        throw new ApiError(
          409,
          'duplicate_realm_host',
          `realm '${existingName}' already connects to ${cfg.host}:${cfg.port ?? 443}`,
        );
      }
    }

    const existing = this.#realms.get(name);
    if (existing) {
      // Idempotent re-PUT: same host/port -> update token/tls and reconnect only if changed.
      existing.conn.stop();
      this.#realms.delete(name);
    }
    this.store.putRealm(name, cfg);
    this.#start(name, cfg, 'api');
    return this.describe(name);
  }

  detach(name) {
    const entry = this.#realms.get(name);
    if (!entry) throw new ApiError(404, 'not_found', `no realm '${name}'`);
    if (entry.source === 'config')
      throw new ApiError(409, 'config_realm', `realm '${name}' is config-declared; remove it from config.json`);
    entry.conn.stop();
    this.#realms.delete(name);
    this.store.deleteRealm(name);
  }

  get(name) {
    const entry = this.#realms.get(name);
    if (!entry) throw new ApiError(404, 'not_found', `no realm '${name}'`);
    return entry.conn;
  }

  describe(name) {
    const { conn, source } = this.#realms.get(name) ?? {};
    if (!conn) throw new ApiError(404, 'not_found', `no realm '${name}'`);
    return {
      realm: name,
      state: conn.state,
      host: conn.cfg.host,
      port: conn.cfg.port ?? 443,
      source,
      systemId: conn.systemId,
      hasToken: !!conn.cfg.token, // token itself is write-only, never echoed
      insecureTls: !!conn.cfg.insecureTls,
      since: conn.since,
      lastError: conn.lastError,
    };
  }

  describeAll() {
    return [...this.#realms.keys()].map((name) => this.describe(name));
  }

  stopAll() {
    for (const { conn } of this.#realms.values()) conn.stop();
  }
}
