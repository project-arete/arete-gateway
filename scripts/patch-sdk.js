#!/usr/bin/env node
// Patch arete-sdk@0.1.6 for gateway use. Idempotent: every patch is guarded by a
// marker comment (arete-gw:*) and skipped if already applied.
//
// Patches:
//   p1-system-id     system.js  — off-Pi system identity via ARETE_SYSTEM_ID or ARETE_SYSTEM_SEED
//   p2-token-tls     index.js   — Bearer token header + per-socket TLS option (NOT the
//                                 process-wide NODE_TLS_REJECT_UNAUTHORIZED toggle: a
//                                 multi-realm gateway must not disable TLS globally)
//   p3-no-sigint     index.js   — remove per-client SIGINT listener (N clients would leak listeners)
//   p4-lifecycle     index.js   — remove internal auto-retry; add dispose(). The gateway owns
//                                 reconnect: every Client is single-use, which structurally
//                                 prevents the zombie-client class of bugs.
//   p5-error-detail  index.js   — pass the real ws error message through (401 visibility)
//   p6-keepalive     index.js   — ws ping every 30s; system(name) optional name argument
//                                 (avoids the os.hostname() rename-on-every-call gotcha)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = path.join(root, 'node_modules', 'arete-sdk');

if (!fs.existsSync(sdk)) {
  console.log('patch-sdk: arete-sdk not installed yet, skipping');
  process.exit(0);
}

let applied = 0;
let skipped = 0;

function patch(file, marker, from, to) {
  const fp = path.join(sdk, file);
  let src = fs.readFileSync(fp, 'utf8');
  if (src.includes(marker)) {
    skipped++;
    return;
  }
  if (!src.includes(from)) {
    console.error(`patch-sdk: ANCHOR NOT FOUND for ${marker} in ${file} — SDK version changed?`);
    process.exit(1);
  }
  src = src.replace(from, to);
  fs.writeFileSync(fp, src);
  applied++;
  console.log(`patch-sdk: applied ${marker}`);
}

// ---------- p1: off-Pi system identity ----------
patch(
  'system.js',
  'arete-gw:p1-system-id',
  `export function get_system_id() {
  if (`,
  `export function get_system_id() {
  // arete-gw:p1-system-id
  if (process.env.ARETE_SYSTEM_ID) return process.env.ARETE_SYSTEM_ID;
  if (process.env.ARETE_SYSTEM_SEED)
    return uuidv5('oid', 'arete-gateway:' + process.env.ARETE_SYSTEM_SEED);
  if (`,
);

// ---------- p2: token + per-socket TLS ----------
patch(
  'index.js',
  'arete-gw:p2-token-tls-opts',
  `      host: options.host || location.hostname,
      port: options.port || location.port,`,
  `      host: options.host || location.hostname,
      port: options.port || location.port,
      // arete-gw:p2-token-tls-opts
      token: options.token || '',
      insecureTls: !!options.insecureTls,`,
);

patch(
  'index.js',
  'arete-gw:p2-ws-options',
  `      const uri = prot + '//' + host + (port ? ':' + port : '');
      this.#socket = new WebSocket(uri);`,
  `      const uri = prot + '//' + host + (port ? ':' + port : '');
      // arete-gw:p2-ws-options
      const wsOpts = {};
      if (this.#options.token)
        wsOpts.headers = { Authorization: 'Bearer ' + this.#options.token };
      if (this.#options.insecureTls) wsOpts.rejectUnauthorized = false;
      this.#socket = new WebSocket(uri, wsOpts);`,
);

// ---------- p3: no per-client SIGINT listener ----------
patch(
  'index.js',
  'arete-gw:p3-no-sigint',
  `    this.open();

    process.on('SIGINT', (_) => {
      this.close();
    });
  }`,
  `    this.open(); // arete-gw:p3-no-sigint
  }`,
);

// ---------- p4: single-use client lifecycle ----------
patch(
  'index.js',
  'arete-gw:p4-lifecycle',
  `  #onclose(e) {
    this.#reset();

    if (e !== undefined && e.wasClean) return;

    if (this.#socket !== undefined) {
      this.#socket = undefined;
      this.emit('close', e);
    }

    setTimeout(() => {
      this.open();
    }, RETRY);
  }`,
  `  // arete-gw:p4-lifecycle — no internal retry; owner reconnects with a fresh Client
  #onclose(e) {
    this.#reset();
    clearInterval(this._pingTimer);

    if (this.#socket !== undefined) {
      this.#socket = undefined;
      this.emit('close', e);
    }
  }

  /**
   * Permanently tear down this client. It cannot be reused.
   */
  dispose() {
    this._disposed = true;
    clearInterval(this._pingTimer);
    if (this.#socket !== undefined) {
      const s = this.#socket;
      this.#socket = undefined;
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.off();
  }`,
);

// ---------- p5: real error detail ----------
patch(
  'index.js',
  'arete-gw:p5-error-detail',
  `  #onerror(e) {
    this.emit('error', new Error(E_SOCKET));
    this.close();
  }`,
  `  // arete-gw:p5-error-detail
  #onerror(e) {
    this.emit('error', new Error(e && e.message ? e.message : E_SOCKET));
    this.close();
  }`,
);

// ---------- p6: keepalive + system(name) ----------
patch(
  'index.js',
  'arete-gw:p6-keepalive',
  `  #onopen(e) {
    //this.emit('open', e);
  }`,
  `  // arete-gw:p6-keepalive
  #onopen(e) {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      try {
        if (this.#socket && this.#socket.ping) this.#socket.ping();
      } catch (_) {
        /* ignore */
      }
    }, 30000);
  }`,
);

patch(
  'index.js',
  'arete-gw:p6-system-name',
  `  system() {
    return new Promise((resolve, reject) => {
      const args = [this.#systemId, os.hostname()];`,
  `  system(name) {
    // arete-gw:p6-system-name
    return new Promise((resolve, reject) => {
      const args = [this.#systemId, name || os.hostname()];`,
);

console.log(`patch-sdk: done (${applied} applied, ${skipped} already present)`);
