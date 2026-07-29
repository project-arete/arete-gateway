// One realm = one single-use SDK Client at a time, owned and reconnected by
// this class. Field-truth rules baked in:
//
//   * VALUE-WIPER PROTECTION: re-issuing a providers/consumers declaration for
//     an existing capability resets all its property values to empty strings
//     (and the empties propagate into every connection). So declaration replay
//     is CONDITIONAL: if .../<role>/<profile>/version already exists in the
//     key cache, the declaration command is skipped and we operate on the
//     existing key paths.
//   * Registration commands are awaited serially — bursts get silently dropped.
//   * No .watch(): connection/property state is derived from the key cache on
//     'update' events.
//   * Single-use clients: the patched SDK never retries internally; on close we
//     dispose the client and schedule a fresh one (no zombie clients).
//   * 401/403 during connect backs off to 5 min, not a 5s-forever loop.

import { Client } from 'arete-sdk';
import { writerRole } from './registry.js';

const BACKOFF_START = 5000;
const BACKOFF_MAX = 60000;
const BACKOFF_MAX_UNAUTHORIZED = 300000;

export class RealmConnection {
  constructor(name, cfg, { store, hub, registry, systemName, log }) {
    this.name = name;
    this.cfg = cfg;
    this.store = store;
    this.hub = hub;
    this.registry = registry;
    this.systemName = systemName;
    this.log = log ?? ((...a) => console.log(`[realm:${name}]`, ...a));

    this.client = null;
    this.systemId = null;
    this.state = 'connecting'; // connecting | connected | error | detached
    this.lastError = null;
    this.since = null;

    this.prevKeys = {};
    this.knownConns = new Map(); // capKey -> Set(connId)
    this.backoff = BACKOFF_START;
    this._stopped = false;
    this._retryTimer = null;
    this._connRe = null;

    this.connect();
  }

  // ---------------- lifecycle ----------------

  async connect() {
    if (this._stopped) return;
    this.state = 'connecting';

    const c = new Client({
      protocol: this.cfg.protocol || 'wss:',
      host: this.cfg.host,
      port: this.cfg.port ?? 443,
      token: this.cfg.token || '',
      insecureTls: !!this.cfg.insecureTls,
    });
    this.client = c;
    const stale = () => this.client !== c || this._stopped;

    c.on('error', (err) => {
      if (stale()) return;
      this.lastError = err.message;
    });
    c.on('close', () => {
      if (stale()) return;
      this.#onDown('socket closed');
    });
    c.on('update', (delta) => {
      if (stale() || this.state !== 'connected') return;
      this.#onUpdate(delta);
    });

    // Arm the snapshot-waiter BEFORE any message can be processed: the SDK
    // emits 'open' on the FIRST MESSAGE (not socket open), which can arrive
    // while waitForOpen is still polling.
    const snapshot = this.#snapshotPromise(c, 12000);
    try {
      await c.waitForOpen(8000);
      await snapshot;
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      if (!stale()) this.#onDown('connect failed');
      return;
    }
    if (stale()) return;

    try {
      await this.#register(c);
    } catch (err) {
      this.lastError = `registration failed: ${err?.message ?? err}`;
      if (!stale()) this.#onDown('registration failed');
      return;
    }
    if (stale()) return;

    this.state = 'connected';
    this.since = new Date().toISOString();
    this.backoff = BACKOFF_START;
    this.prevKeys = { ...c.keys };
    this._connRe = new RegExp(
      `^cns/${this.systemId}/nodes/([^/]+)/contexts/([^/]+)/(provider|consumer)/([^/]+)/connections/([^/]+)(?:/(.*))?$`,
    );
    this.log(`connected to ${this.cfg.host} as system ${this.systemId}`);
    this.hub.emit('realm.connected', { realm: this.name });

    // Emit connection.created for connections that already exist (or appeared
    // while we were away). At-least-once posture: a restart re-emits.
    for (const key of Object.keys(c.keys)) this.#trackKey(key, c.keys[key], true);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    if (this.state === 'connected') {
      this.hub.emit('realm.disconnected', {
        realm: this.name,
        data: { reason: 'detached' },
      });
    }
    this.state = 'detached';
  }

  #onDown(reason) {
    const wasConnected = this.state === 'connected';
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    if (wasConnected) {
      this.log(`down: ${reason} (${this.lastError ?? 'no error detail'})`);
      this.hub.emit('realm.disconnected', {
        realm: this.name,
        data: { reason, error: this.lastError },
      });
    }
    if (this._stopped) return;

    const unauthorized = /401|403/.test(this.lastError || '');
    this.state = unauthorized ? 'error' : 'connecting';
    const delay = this.backoff;
    this.backoff = Math.min(
      this.backoff * 2,
      unauthorized ? BACKOFF_MAX_UNAUTHORIZED : BACKOFF_MAX,
    );
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  #snapshotPromise(c, ms) {
    // A healthy realm sends its snapshot immediately after upgrade; a realm
    // that accepts the socket but never sends anything (the dashboard.test
    // failure mode) is treated as dead.
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('realm sent no snapshot (dead or not a CNS realm)')),
        ms,
      );
      c.on('open', () => {
        clearTimeout(t);
        resolve();
      });
      c.on('close', () => {
        clearTimeout(t);
        reject(new Error(this.lastError || 'socket closed before snapshot'));
      });
    });
    p.catch(() => {}); // avoid unhandled rejection if waitForOpen throws first
    return p;
  }

  // ---------------- registration & replay ----------------

  async #register(c) {
    const sys = await c.system(this.systemName); // patched: registers with OUR name
    this.systemId = sys.id;

    const tree = this.store.getTree(this.name);
    for (const [nodeId, node] of Object.entries(tree.nodes)) {
      await c.command('nodes', this.systemId, nodeId, node.name, !!node.upstream, null);
      for (const [ctxId, ctx] of Object.entries(node.contexts)) {
        await c.command('contexts', this.systemId, nodeId, ctxId, ctx.name);
        for (const [declKey, decl] of Object.entries(ctx.declarations)) {
          const slash = declKey.indexOf('/');
          const role = declKey.slice(0, slash);
          const profile = declKey.slice(slash + 1);
          await this.declareOnWire(nodeId, ctxId, role, profile, decl, c);
        }
      }
    }
  }

  capPrefix(node, ctx, role, profile) {
    return `cns/${this.systemId}/nodes/${node}/contexts/${ctx}/${role}/${profile}`;
  }

  /**
   * Issue a capability declaration on the wire — UNLESS it already exists
   * (version key present), in which case skip it entirely so existing property
   * values are never wiped. Initial property values are only written on a
   * fresh declaration.
   */
  async declareOnWire(node, ctx, role, profile, decl, client) {
    const c = client ?? this.requireClient();
    const prefix = this.capPrefix(node, ctx, role, profile);
    const exists = c.get(`${prefix}/version`) !== null;
    if (exists) {
      this.log(`declaration ${role}/${profile} already on realm — skipped (value-wiper protection)`);
      return { replayed: false };
    }
    const cmd = role === 'provider' ? 'providers' : 'consumers';
    await c.command(cmd, this.systemId, node, ctx, profile);
    for (const [prop, val] of Object.entries(decl.properties ?? {})) {
      await c.put(`${prefix}/properties/${prop}`, String(val));
    }
    return { replayed: true };
  }

  // ---------------- wire ops used by the API ----------------

  requireClient() {
    if (this.state !== 'connected' || !this.client) {
      const err = new Error(`realm '${this.name}' is not connected (state: ${this.state})`);
      err.status = 503;
      err.code = 'realm_unreachable';
      throw err;
    }
    return this.client;
  }

  async registerNode(nodeId, node) {
    const c = this.requireClient();
    await c.command('nodes', this.systemId, nodeId, node.name, !!node.upstream, null);
  }

  async registerContext(nodeId, ctxId, ctx) {
    const c = this.requireClient();
    await c.command('contexts', this.systemId, nodeId, ctxId, ctx.name);
  }

  async putCapabilityProperty(node, ctx, role, profile, prop, value) {
    const c = this.requireClient();
    await c.put(`${this.capPrefix(node, ctx, role, profile)}/properties/${prop}`, String(value));
  }

  async putConnectionProperty(node, ctx, role, profile, conn, prop, value) {
    const c = this.requireClient();
    await c.put(
      `${this.capPrefix(node, ctx, role, profile)}/connections/${conn}/properties/${prop}`,
      String(value),
    );
  }

  // ---------------- reads (key-cache derivation) ----------------

  keys() {
    return this.client?.keys ?? {};
  }

  capabilityProperties(node, ctx, role, profile) {
    const prefix = `${this.capPrefix(node, ctx, role, profile)}/properties/`;
    const out = {};
    for (const [key, value] of Object.entries(this.keys())) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        out[key.slice(prefix.length)] = value;
    }
    return out;
  }

  connections(node, ctx, role, profile) {
    const prefix = `${this.capPrefix(node, ctx, role, profile)}/connections/`;
    const conns = {};
    for (const [key, value] of Object.entries(this.keys())) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      const connId = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? '' : rest.slice(slash + 1);
      const conn = (conns[connId] = conns[connId] ?? { conn: connId, properties: {}, attributes: {} });
      if (sub.startsWith('properties/')) {
        conn.properties[sub.slice('properties/'.length)] = value;
      } else if (sub) {
        conn.attributes[sub] = value;
      } else {
        conn.attributes[''] = value;
      }
    }
    return Object.values(conns).map((c) => ({ ...c, state: 'bound' }));
  }

  connection(node, ctx, role, profile, connId) {
    return this.connections(node, ctx, role, profile).find((c) => c.conn === connId) ?? null;
  }

  // Realm-wide introspection (visibility = whatever governance grants us).

  listSystems() {
    const out = [];
    for (const [key, value] of Object.entries(this.keys())) {
      const m = key.match(/^cns\/([^/]+)\/name$/);
      if (m) out.push({ system: m[1], name: value, self: m[1] === this.systemId });
    }
    return out;
  }

  listContexts() {
    const ctxs = {};
    for (const [key, value] of Object.entries(this.keys())) {
      const m = key.match(/^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/name$/);
      if (m) {
        const [, sys, node, ctx] = m;
        ctxs[ctx] = ctxs[ctx] ?? { context: ctx, names: [] };
        ctxs[ctx].names.push({ system: sys, node, name: value });
      }
    }
    return Object.values(ctxs);
  }

  listParticipants(ctxId) {
    const out = [];
    for (const key of Object.keys(this.keys())) {
      const m = key.match(
        /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)\/version$/,
      );
      if (m && m[3] === ctxId) {
        out.push({ system: m[1], node: m[2], role: m[4], profile: m[5], self: m[1] === this.systemId });
      }
    }
    return out;
  }

  // ---------------- event derivation ----------------

  #onUpdate(delta) {
    const keys = delta?.keys;
    if (!keys) return;
    for (const [key, value] of Object.entries(keys)) {
      this.#trackKey(key, value, false);
      if (value === null) delete this.prevKeys[key];
      else this.prevKeys[key] = value;
    }
  }

  #trackKey(key, value, initialScan) {
    if (!this._connRe) return;
    const m = key.match(this._connRe);
    if (!m) return;
    const [, node, ctx, role, profile, connId, rest] = m;
    const capKey = `${node}|${ctx}|${role}|${profile}`;

    let set = this.knownConns.get(capKey);
    if (!set) this.knownConns.set(capKey, (set = new Set()));

    if (value !== null && !set.has(connId)) {
      set.add(connId);
      this.hub.emit('connection.created', {
        realm: this.name,
        node,
        context: ctx,
        role,
        profile,
        conn: connId,
        data: { peer: this.#peerOf(node, ctx, role, profile, connId) },
      });
    }

    if (!initialScan && rest && rest.startsWith('properties/') && value !== null) {
      const property = rest.slice('properties/'.length);
      const previous = this.prevKeys[key] ?? null;
      if (previous === value) return;
      const flags = this.registry.flagsOf(profile);
      let origin = 'unknown';
      if (flags && flags[property]) {
        origin = writerRole(flags[property]) === role ? 'self' : 'peer';
      }
      this.hub.emit('property.changed', {
        realm: this.name,
        node,
        context: ctx,
        role,
        profile,
        conn: connId,
        data: { property, value, previous, origin },
      });
    }
  }

  #peerOf(node, ctx, role, profile, connId) {
    // Best-effort peer identification: another system declaring the
    // complementary role for the same profile in the same context.
    const other = role === 'provider' ? 'consumer' : 'provider';
    for (const p of this.listParticipants(ctx)) {
      if (!p.self && p.role === other && p.profile === profile) {
        return { system: p.system, node: p.node, role: p.role };
      }
    }
    return null;
  }
}
